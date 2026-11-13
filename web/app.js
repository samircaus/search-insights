/**
 * Search Insights — Experience Workspace library plugin.
 * "What brings people to this page, what has changed, and what should I review?"
 */
import { connectWorkspace } from './workspace.js';
import { createApi, ApiError } from './api.js';
import { createDemoApi, DEMO_PAGES } from './fixtures/demo.js';
import { resolvePublicUrl, validateOverride } from './core/url-resolver.js';
import { findOpportunities, mergeThresholds } from './core/opportunities.js';
import { buildBrief, buildWorkspacePrompt } from './core/brief.js';
import { inspectionHeadline } from './core/inspection.js';
import { fmtRange, fmtRangeShort } from './core/dates.js';
import {
  fmtInt, fmtPct, fmtPos, fmtRelChange, fmtPp, changeDirection, isNum,
} from './core/metrics.js';
import { h, announce, replace, replaceKeepingFocus } from './ui/dom.js';

import { PROVIDERS, visibleProviders, pickActive } from './ui/providers.js';
import { QUERY_BATCH_SIZE, queryWindow } from './ui/queries.js';
import { PERIOD_DAYS, periodDays } from './ui/period.js';

const state = {
  mode: 'live', // 'live' | 'demo'
  ws: null,
  api: null,
  site: null,
  providers: null,
  connections: {},
  docPath: null,
  resolution: null,
  pageUrl: null,
  pageCheck: null,
  active: 'google',
  property: null,
  properties: null,
  per: {},
  showOverride: false,
  days: null,
};

function perProvider(id) {
  if (!state.per[id]) {
    state.per[id] = {
      status: 'idle', result: null, error: null, opps: null,
      selectedQueries: new Set(), selectedCards: new Set(),
      inspection: { status: 'idle', data: null, error: null },
      sort: { key: 'clicks', dir: 'desc' }, filter: 'all', search: '', queryLimit: QUERY_BATCH_SIZE,
    };
  }
  return state.per[id];
}

const app = () => document.getElementById('app');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('demo')) {
    const only = params.get('providers');
    state.demoProviders = only ? only.split(',').map((s) => s.trim()) : undefined;
    return startDemo(params.get('page'));
  }

  const ws = await connectWorkspace();
  if (ws.status !== 'ready') return renderOutside(ws.status);
  state.ws = ws;
  const { context } = ws;
  if (!context.org || !(context.site || context.repo)) {
    return renderFatal('Workspace did not provide the site for this document.', 'Open a document in Experience Workspace and launch Search Insights again.');
  }
  state.api = createApi({ getToken: ws.getToken, org: context.org, site: context.site || context.repo });
  state.docPath = context.path || null;
  try {
    const cfg = await state.api.config();
    state.site = cfg.site;
    state.providers = cfg.providers;
    state.active = pickActive(state.active, state.providers);
  } catch (e) {
    return renderFatal(errorTitle(e), e.message);
  }
  resolveUrl();
  render();
  refreshConnections();
  return undefined;
}

async function startDemo(pagePath) {
  state.mode = 'demo';
  state.api = createDemoApi({ providers: state.demoProviders });
  const cfg = await state.api.config();
  state.site = cfg.site;
  state.providers = cfg.providers;
  state.active = pickActive(state.active, state.providers);
  const page = DEMO_PAGES.find((p) => p.path === pagePath) || DEMO_PAGES[0];
  state.docPath = page.path;
  state.per = {};
  resolveUrl();
  render();
  refreshConnections();
}

function resolveUrl() {
  const ctx = state.mode === 'demo'
    ? { org: state.site.da.org, site: state.site.da.site, path: state.docPath }
    : state.ws.context;
  state.resolution = resolvePublicUrl(ctx, state.site);
  state.pageUrl = state.resolution.status === 'resolved' ? state.resolution.url : null;
  state.pageCheck = null;
  if (state.pageUrl) checkPage();
}

async function checkPage() {
  const url = state.pageUrl;
  try {
    const res = await state.api.pageCheck(url);
    if (url !== state.pageUrl) return;
    state.pageCheck = res;
  } catch (e) {
    state.pageCheck = { status: 'check-failed', message: e.message };
  }
  renderIdentity();
}

async function refreshConnections() {
  try {
    state.connections = await state.api.status();
  } catch (e) {
    state.connections = { error: e };
  }
  renderTabs();
  loadActive();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadActive({ refresh = false } = {}) {
  const id = state.active;
  if (!id) { renderPanel(); return; }
  const p = perProvider(id);
  const conn = state.connections?.[id];
  if (!state.pageUrl) { renderPanel(); return; }
  if (!state.providers?.[id]?.enabled) { p.status = 'disabled'; renderPanel(); return; }
  if (!state.providers?.[id]?.configured) { p.status = 'not-configured'; renderPanel(); return; }
  if (!conn?.connected) { p.status = 'not-connected'; renderPanel(); return; }
  if (id === 'google' && !state.properties && state.mode === 'live') loadProperties();
  p.status = 'loading';
  p.error = null;
  renderPanel();
  const reqUrl = state.pageUrl;
  if (id === 'google') loadInspection({ refresh });
  try {
    const result = await state.api.report(id, state.pageUrl, {
      property: id === 'google' ? state.property || undefined : undefined,
      days: currentDays(),
      refresh,
    });
    if (reqUrl !== state.pageUrl) return;
    p.result = result;
    p.opps = findOpportunities(result, mergeThresholds(state.site.thresholds || {}));
    const availableCards = new Set(p.opps.cards.map((card) => card.id));
    const availableQueries = new Set(result.queries.map((row) => row.query));
    const selectedBefore = p.selectedCards.size + p.selectedQueries.size;
    for (const card of p.selectedCards) if (!availableCards.has(card)) p.selectedCards.delete(card);
    for (const query of p.selectedQueries) if (!availableQueries.has(query)) p.selectedQueries.delete(query);
    p.status = result.hasData ? 'ready' : 'empty';
    const removed = selectedBefore - p.selectedCards.size - p.selectedQueries.size;
    announce(`${labelOf(id)} data loaded.${removed ? ' Some selected items are no longer available.' : ''}`);
  } catch (e) {
    if (reqUrl !== state.pageUrl) return;
    p.status = 'error';
    p.error = e;
    if (e.code === 'NOT_CONNECTED' || e.code === 'REAUTH_REQUIRED') {
      state.connections[id] = { ...(state.connections[id] || {}), connected: false, reauth: e.code === 'REAUTH_REQUIRED' };
      renderTabs();
    }
    announce(`${labelOf(id)}: ${e.message}`);
  }
  renderTabs();
  if (state.active === id) renderPanel();
}

async function loadInspection({ refresh = false } = {}) {
  const p = perProvider('google');
  const reqUrl = state.pageUrl;
  p.inspection = { status: 'loading', data: null, error: null };
  renderInspection();
  try {
    const data = await state.api.inspect(reqUrl, { property: state.property || undefined, refresh });
    if (reqUrl !== state.pageUrl) return;
    p.inspection = { status: 'ready', data, error: null };
  } catch (e) {
    if (reqUrl !== state.pageUrl) return;
    p.inspection = { status: 'error', data: null, error: e };
  }
  renderInspection();
}

async function loadProperties() {
  try {
    const { properties } = await state.api.properties();
    state.properties = properties;
    if (!state.property) {
      const first = properties.find((p) => p.accessible);
      state.property = first ? first.property : null;
    }
  } catch (e) {
    state.properties = { error: e };
  }
  if (state.active === 'google') renderPanel();
}

async function connect(id) {
  // Open the window synchronously (user gesture) to avoid popup blockers,
  // then point it at the provider once the backend created the request.
  const popup = window.open('', `si-oauth-${id}`, 'width=520,height=700');
  const p = perProvider(id);
  try {
    const { authorizeUrl } = await state.api.startOAuth(id);
    if (popup && !popup.closed) {
      popup.location.href = authorizeUrl;
    } else {
      p.popupLink = authorizeUrl;
      renderPanel();
    }
  } catch (e) {
    if (popup) popup.close();
    p.status = 'error';
    p.error = e;
    renderPanel();
    return;
  }
  p.status = 'connecting';
  renderPanel();
  const started = Date.now();
  const poll = async () => {
    try {
      const conns = await state.api.status();
      if (conns?.[id]?.connected) {
        state.connections = conns;
        p.popupLink = null;
        renderTabs();
        announce(`${labelOf(id)} connected.`);
        loadActive();
        return;
      }
    } catch { /* keep polling */ }
    const closed = popup ? popup.closed : false;
    if (Date.now() - started > 180000 || (closed && Date.now() - started > 4000 && p.closedChecks > 1)) {
      p.status = 'not-connected';
      renderPanel();
      return;
    }
    if (closed) p.closedChecks = (p.closedChecks || 0) + 1;
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
}

async function disconnectProvider(id) {
  try {
    await state.api.disconnect(id);
  } catch { /* ignore */ }
  const p = perProvider(id);
  p.result = null;
  state.properties = id === 'google' ? null : state.properties;
  refreshConnections();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const labelOf = (id) => PROVIDERS.find((p) => p.id === id)?.long || id;

function errorTitle(e) {
  switch (e?.code) {
    case 'UNAUTHENTICATED': return 'Session not verified';
    case 'FORBIDDEN_SITE': return 'This site is not available';
    case 'NETWORK': return 'Service unreachable';
    default: return 'Something went wrong';
  }
}

function renderOutside(reason) {
  const msg = {
    outside: 'Search Insights runs inside Adobe Experience Workspace as a library plugin. It needs the current document and your Workspace session.',
    'no-handshake': 'Experience Workspace did not respond. Reload the document and open Search Insights again.',
    'sdk-unavailable': 'The Experience Workspace SDK could not be loaded from da.live.',
  }[reason] || 'Search Insights could not start.';
  replace(app(), h('section', { class: 'outside' },
    h('h1', {}, 'Search Insights'),
    h('p', {}, msg),
    h('p', {}, 'To add it to a site, follow the Workspace registration steps in the project README.'),
    h('div', { class: 'row' },
      h('a', { class: 'button primary nx-btn-accent', href: '?demo' }, 'Explore with demo data'))));
}

function renderFatal(title, message) {
  replace(app(), h('section', { class: 'outside', role: 'alert' },
    h('h1', {}, title), h('p', {}, message)));
}

function render() {
  replace(app(),
    h('header', { class: 'identity', id: 'identity' }),
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Search provider', id: 'tabs' }),
    h('section', { class: 'panel', id: 'panel', role: 'tabpanel', tabindex: '-1' }),
    showDiagnostics() ? renderDiagnostics() : null);
  renderIdentity();
  renderTabs();
  renderPanel();
}

function statusLight(variant, text, attrs = {}) {
  return h('span', { class: `status-light is-${variant}`, ...attrs }, text);
}

function badge() {
  return state.mode === 'demo'
    ? statusLight('notice', 'Demo data', { title: 'Fictional fixture data for demonstration' })
    : null;
}

function multiProvider() {
  return visibleProviders(state.providers).length > 1;
}

function renderIdentity() {
  const el = document.getElementById('identity');
  if (!el) return;
  const r = state.resolution || {};
  const children = [
    h('div', { class: 'title-row' }, h('h1', {}, 'Search Insights'), badge()),
  ];
  if (state.mode === 'demo') {
    const sel = h('select', {
      class: 'nx-input',
      id: 'demo-page',
      onchange: (e) => startDemo(e.target.value),
    }, DEMO_PAGES.map((p) => h('option', { value: p.path, selected: p.path === state.docPath }, p.label)));
    children.push(h('div', { class: 'field' }, h('label', { for: 'demo-page' }, 'Demo page'), sel));
  }
  const changeUrl = h('button', {
    type: 'button', class: 'link-button nx-action-btn-quiet nx-btn-sm', 'aria-expanded': String(state.showOverride),
    onclick: () => { state.showOverride = !state.showOverride; renderIdentity(); },
  }, state.showOverride ? 'Cancel' : 'Change URL');
  children.push(h('div', { class: 'page-meta' },
    h('p', { class: 'page-url' }, state.pageUrl
      ? h('a', { href: state.pageUrl, target: '_blank', rel: 'noopener noreferrer', title: state.pageUrl }, state.pageUrl.replace(/^https?:\/\//, ''))
      : h('span', { class: 'muted' }, resolutionMessage(r))),
    changeUrl));

  if (r.status === 'needs-confirmation' && r.url) {
    children.push(h('div', { class: 'notice' },
      h('p', {}, `Please confirm the public URL: ${r.url}`),
      h('button', { class: 'button nx-form-btn-secondary', onclick: () => applyOverride(r.url) }, 'Use this URL')));
  }
  (r.notes || []).forEach((n) => children.push(h('p', { class: 'hint' }, n)));
  const check = state.pageCheck ? pageCheckNotice(state.pageCheck) : null;
  if (check) children.push(check);
  if (state.showOverride) children.push(overrideForm());
  replace(el, children);
}

function resolutionMessage(r) {
  switch (r.reason) {
    case 'not-public': return 'This document is not a public page (for example a draft, fragment or tool).';
    case 'not-a-page': return 'This document is not an HTML page (for example a sheet or media file).';
    case 'site-mismatch': return 'This document belongs to a different site than the configured one.';
    case 'no-document-path': return 'No document is open.';
    case 'uppercase-path': return 'The URL needs confirmation.';
    default: return 'The public URL could not be determined.';
  }
}

function pageCheckNotice(pc) {
  if (pc.status === 'ok' && pc.canonical?.status === 'differs') {
    return h('div', { class: 'notice' },
      h('p', {}, `The published page declares a different canonical URL: ${pc.canonical.canonical}. Search providers usually report the canonical URL.`),
      h('button', { class: 'button nx-form-btn-secondary', onclick: () => applyOverride(pc.canonical.canonical) }, 'Use canonical URL'));
  }
  if (pc.status === 'ok' && pc.redirected) {
    return h('p', { class: 'hint' }, `This URL redirects to ${pc.finalUrl}.`);
  }
  if (pc.status === 'not-found') {
    return h('p', { class: 'notice' }, 'This URL is not published (404). New or unpublished pages have no search data yet.');
  }
  if (pc.status === 'ok') return null;
  if (pc.status === 'check-failed') return null;
  return h('p', { class: 'hint' }, `Published page check: ${pc.status}.`);
}

function overrideForm() {
  const input = h('input', {
    id: 'override', type: 'url', class: 'input nx-input', placeholder: `${state.site.productionOrigin}/path`, value: state.pageUrl || '',
    'aria-describedby': 'override-help',
  });
  const err = h('p', { class: 'error', id: 'override-err', role: 'alert' });
  return h('form', {
    class: 'override',
    onsubmit: (e) => {
      e.preventDefault();
      const v = validateOverride(input.value, state.site);
      if (!v.ok) {
        err.textContent = {
          'origin-not-allowed': `Only URLs on ${state.site.productionOrigin} are allowed.`,
          'other-site': 'That preview URL belongs to a different site.',
          'invalid-url': 'Enter a full URL or a path starting with “/”.',
        }[v.reason] || 'That URL is not allowed.';
        return;
      }
      applyOverride(v.url);
    },
  },
  h('label', { for: 'override' }, 'Public URL'),
  input,
  h('p', { class: 'hint', id: 'override-help' }, `Must be on ${state.site.productionOrigin}. Preview URLs of this site are mapped automatically.`),
  err,
  h('button', { class: 'button primary nx-btn-accent', type: 'submit' }, 'Apply'));
}

function applyOverride(url) {
  const v = validateOverride(url, state.site);
  if (!v.ok) return;
  state.pageUrl = v.url;
  state.resolution = { status: 'resolved', url: v.url, notes: ['URL set manually.', ...v.notes] };
  state.showOverride = false;
  state.per = {};
  renderIdentity();
  checkPage();
  loadActive();
}

function tabStatus(id) {
  const prov = state.providers?.[id];
  const conn = state.connections?.[id];
  const p = state.per[id];
  if (!prov?.enabled) return 'Not enabled';
  if (!prov.configured) return 'Not configured';
  if (p?.status === 'error') return 'Error';
  if (conn?.reauth) return 'Reconnect needed';
  if (!conn) return '…';
  return conn.connected ? 'Connected' : 'Not connected';
}

function renderTabs() {
  const el = document.getElementById('tabs');
  if (!el) return;
  const tabs = visibleProviders(state.providers);
  el.hidden = tabs.length < 2;
  replaceKeepingFocus(el, tabs.map((p, i) => {
    const selected = state.active === p.id;
    const status = tabStatus(p.id);
    return h('button', {
      role: 'tab',
      id: `tab-${p.id}`,
      'aria-selected': String(selected),
      'aria-controls': 'panel',
      tabindex: selected ? '0' : '-1',
      class: `tab ${selected ? 'selected' : ''}`,
      onclick: () => selectTab(p.id),
      onkeydown: (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          selectTab(next.id);
          document.getElementById(`tab-${next.id}`)?.focus();
        }
      },
    }, h('span', { class: 'tab-label' }, p.label), h('span', { class: `tab-status s-${status.replace(/\W+/g, '-').toLowerCase()}` }, status));
  }));
}

function selectTab(id) {
  if (state.active === id) return;
  state.active = id;
  renderTabs();
  const p = perProvider(id);
  if (p.status === 'ready' || p.status === 'empty' || p.status === 'loading') renderPanel();
  else loadActive();
}

function renderPanel() {
  const el = document.getElementById('panel');
  if (!el) return;
  const id = state.active;
  if (!id) {
    el.removeAttribute('aria-labelledby');
    el.removeAttribute('role');
    replace(el, h('p', { class: 'empty' }, 'No search providers are available for this site. Ask the person who deployed Search Insights to configure Google or Bing.'));
    return;
  }
  if (multiProvider()) {
    el.setAttribute('role', 'tabpanel');
    el.setAttribute('aria-labelledby', `tab-${id}`);
  } else {
    el.removeAttribute('role');
    el.removeAttribute('aria-labelledby');
  }
  const p = perProvider(id);
  const parts = [connectionBar(id)];

  if (!state.pageUrl) {
    parts.push(h('p', { class: 'empty' }, 'Choose a public URL to see search data.'));
    replace(el, parts);
    return;
  }
  switch (p.status) {
    case 'disabled':
      parts.push(h('p', { class: 'empty' }, `${labelOf(id)} is not enabled for this site.`));
      break;
    case 'not-configured':
      parts.push(h('p', { class: 'empty' }, `${labelOf(id)} credentials are not configured on the Search Insights service. Ask the person who deployed it to follow the README.`));
      break;
    case 'not-connected':
    case 'connecting':
      parts.push(connectPrompt(id, p));
      break;
    case 'loading':
      parts.push(h('div', { class: 'period' }, periodPicker()),
        h('p', { class: 'loading', role: 'status' }, `Loading ${labelOf(id)} data…`));
      break;
    case 'error':
      parts.push(errorBox(id, p.error));
      break;
    case 'empty':
      parts.push(periodBar(id, p.result), inspectionSlot(id), noDataBox(id, p.result), dataNotes(id, p.result));
      break;
    case 'ready':
      parts.push(
        periodBar(id, p.result),
        summaryTiles(p.result),
        inspectionSlot(id),
        selectionArea(id, p),
        dataNotes(id, p.result),
      );
      break;
    default:
      parts.push(h('p', { class: 'loading' }, 'Preparing…'));
  }
  replaceKeepingFocus(el, parts);
}

function currentDays() {
  return periodDays(state.days, state.site?.reportingDays);
}

function periodPicker() {
  return h('div', { class: 'field inline period-picker' },
    h('label', { for: 'period-days', class: 'visually-hidden' }, 'Reporting period'),
    h('select', {
      class: 'nx-input',
      id: 'period-days',
      onchange: (e) => {
        state.days = periodDays(e.target.value, state.site?.reportingDays);
        state.per = {};
        loadActive();
      },
    }, PERIOD_DAYS.map((d) => h('option', { value: String(d), selected: d === currentDays() }, `Last ${d} days`))));
}

function connectionBar(id) {
  const conn = state.connections?.[id];
  if (!conn?.connected || id !== 'google' || !Array.isArray(state.properties)) return null;
  const accessible = state.properties.filter((pr) => pr.accessible || pr.property === state.property);
  if (accessible.length < 2) return null;
  return h('div', { class: 'provider-bar' },
    h('div', { class: 'field inline' },
      h('label', { for: 'property' }, 'Property'),
      h('select', {
        class: 'nx-input',
        id: 'property',
        onchange: (e) => { state.property = e.target.value; perProvider('google').result = null; loadActive(); },
      }, accessible.map((pr) => h('option', { value: pr.property, selected: pr.property === state.property }, pr.property)))));
}

function accountMenu(id, conn) {
  const items = [];
  if (conn.account) items.push(h('div', { class: 'menu-section' }, h('span', { class: 'menu-label' }, 'Signed in as'), h('span', {}, conn.account)));
  if (id === 'google' && state.property) items.push(h('div', { class: 'menu-section' }, h('span', { class: 'menu-label' }, 'Search Console property'), h('span', {}, state.property)));
  const canDisconnect = state.mode === 'live' && state.providers?.[id]?.auth === 'oauth';
  const menuId = `account-menu-${id}`;
  const trigger = h('button', {
    type: 'button', class: 'nx-action-btn-quiet nx-btn-sm', popovertarget: menuId, 'aria-haspopup': 'dialog',
  }, 'Account');
  const menu = h('div', {
    id: menuId, class: 'menu', popover: 'auto', role: 'dialog', 'aria-label': `${labelOf(id)} account`,
    ontoggle: (e) => {
      trigger.setAttribute('aria-expanded', String(e.newState === 'open'));
      if (e.newState !== 'open') return;
      const r = trigger.getBoundingClientRect();
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
      window.addEventListener('scroll', () => menu.hidePopover?.(), { once: true, capture: true });
    },
  }, items, h('button', {
    type: 'button', class: 'menu-item',
    onclick: () => { menu.hidePopover?.(); loadActive({ refresh: true }); },
  }, 'Refresh data'), canDisconnect ? h('button', {
    type: 'button', class: 'menu-item',
    onclick: () => { menu.hidePopover?.(); disconnectProvider(id); },
  }, `Disconnect ${labelOf(id)}`) : null);
  trigger.setAttribute('aria-expanded', 'false');
  return [trigger, menu];
}

function connectPrompt(id, p) {
  const conn = state.connections?.[id];
  const isApiKey = state.providers?.[id]?.auth === 'apiKey';
  if (isApiKey) {
    return h('p', { class: 'empty' }, `${labelOf(id)} uses a deployment API key that is not available.`);
  }
  return h('div', { class: 'connect' },
    h('p', {}, conn?.reauth
      ? `Your ${labelOf(id)} authorization expired or was revoked.`
      : `Connect ${labelOf(id)} to see search data for this page. Access is read-only.`),
    p.status === 'connecting'
      ? h('p', { class: 'loading', role: 'status' }, 'Waiting for you to finish in the sign-in window…')
      : h('button', { class: 'button primary nx-btn-accent', onclick: () => connect(id) }, conn?.reauth ? 'Reconnect' : `Connect ${labelOf(id)}`),
    p.popupLink ? h('p', {}, 'Your browser blocked the sign-in window. ',
      h('a', { href: p.popupLink, target: '_blank', rel: 'noopener' }, 'Open the sign-in page')) : null,
    state.mode === 'demo' ? h('p', { class: 'hint' }, 'Connections are simulated in demo mode.') : null);
}

function errorBox(id, e) {
  const code = e instanceof ApiError ? e.code : 'INTERNAL';
  const actions = [];
  if (code === 'REAUTH_REQUIRED' || code === 'NOT_CONNECTED') {
    actions.push(h('button', { class: 'button primary nx-btn-accent', onclick: () => connect(id) }, 'Reconnect'));
  } else if (['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'NETWORK', 'INTERNAL'].includes(code)) {
    actions.push(h('button', { class: 'button nx-form-btn-secondary', onclick: () => loadActive({ refresh: true }) }, 'Try again'));
  }
  const title = {
    REAUTH_REQUIRED: 'Reauthorization required',
    NOT_CONNECTED: 'Not connected',
    PROPERTY_ACCESS_DENIED: 'Property access denied',
    RATE_LIMITED: 'Rate limited',
    PROVIDER_UNAVAILABLE: 'Provider unavailable',
    URL_NOT_ALLOWED: 'URL not allowed',
  }[code] || 'Could not load data';
  return h('div', { class: 'error-box', role: 'alert' },
    h('h2', {}, `${labelOf(id)}: ${title}`),
    h('p', {}, e?.message || 'Unknown error.'),
    code === 'PROPERTY_ACCESS_DENIED' ? h('p', { class: 'hint' }, 'Check that the connected account is a user of this property in the provider’s tools.') : null,
    h('p', { class: 'hint' }, 'The other provider is not affected.'),
    actions);
}

function noDataBox(id, result) {
  return h('div', { class: 'empty-box' },
    h('h2', {}, 'No search data available'),
    h('p', {}, `${labelOf(id)} reported no impressions for ${result.requestedUrl}${result.periods?.current ? ` between ${fmtRange(result.periods.current)}` : ''}.`),
    h('p', { class: 'hint' }, 'New or recently published pages often take days to weeks to appear. Check that the URL above is the one search engines index (see the canonical check).'));
}

function periodBar(id, result) {
  const p = result.periods || {};
  const gran = p.granularity === 'week' ? ' (weekly rows)' : '';
  const sameYear = p.current && p.previous && p.current.end?.slice(0, 4) === p.previous.end?.slice(0, 4);
  const prev = result.comparison?.available && p.previous
    ? `vs ${fmtRangeShort(p.previous, { omitYear: sameYear })}`
    : (result.comparison?.reason || 'No comparison available.');
  return h('div', { class: 'period' }, periodPicker(),
    h('p', {}, h('strong', {}, p.current ? fmtRangeShort(p.current) : 'No period'), gran, ' ', h('span', { class: 'muted' }, prev)),
    state.connections?.[id]?.connected ? h('div', { class: 'period-account' }, accountMenu(id, state.connections[id])) : null);
}

function changeText(kind, change) {
  if (!change) return null;
  if (kind === 'ctr') {
    if (!isNum(change)) return { text: 'not comparable', dir: 'flat' };
    return { text: fmtPp(change), dir: change > 0.05 ? 'up' : change < -0.05 ? 'down' : 'flat' };
  }
  if (kind === 'position') {
    if (!change) return { text: 'not comparable', dir: 'flat' };
    const abs = Math.abs(change.delta).toFixed(1);
    if (change.direction === 'improved') return { text: `Improved ${abs}`, dir: 'good' };
    if (change.direction === 'declined') return { text: `Worse by ${abs}`, dir: 'bad' };
    return { text: 'unchanged', dir: 'flat' };
  }
  return { text: fmtRelChange(change), dir: changeDirection(change) };
}

function tile(label, value, change, sr, help) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-label', title: help }, label),
    h('div', { class: 'tile-value' }, value),
    change ? h('div', { class: `tile-change d-${change.dir}`, 'aria-label': sr }, change.text) : null);
}

function summaryTiles(result) {
  const s = result.summary;
  const comp = result.comparison?.available;
  const c = s.change;
  const tiles = [
    tile('Clicks', fmtInt(s.current.clicks), comp ? changeText('rel', c.clicks) : null,
      comp ? `Clicks change ${fmtRelChange(c.clicks)} versus previous period` : undefined),
    tile('Impressions', fmtInt(s.current.impressions), comp ? changeText('rel', c.impressions) : null,
      comp ? `Impressions change ${fmtRelChange(c.impressions)}` : undefined),
    tile('CTR', fmtPct(s.current.ctr), comp ? changeText('ctr', c.ctrPp) : null,
      comp ? `CTR change ${fmtPp(c.ctrPp)}` : undefined),
  ];
  if (result.metrics?.position?.available) {
    tiles.push(tile('Avg. position', fmtPos(s.current.position), comp ? changeText('position', c.position) : null,
      comp ? 'Average position change; lower is better' : undefined, 'Lower is better. Position 1 is the top result.'));
  }
  return h('section', { class: 'summary', 'aria-label': 'Performance summary' },
    h('div', { class: 'tiles' }, tiles),
    s.source === 'derived-from-query-rows' ? h('p', { class: 'hint' }, 'Totals are summed from the top queries returned.') : null);
}

function inspectionSlot(id) {
  if (id !== 'google') return null;
  const el = h('section', { class: 'inspection', id: 'inspection-google', 'aria-label': 'Google index status' });
  fillInspection(el);
  return el;
}

function renderInspection() {
  const el = document.getElementById('inspection-google');
  if (el) fillInspection(el);
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fillInspection(el) {
  const ins = perProvider('google').inspection;
  const head = h('h2', {}, 'Index status');
  if (ins.status === 'loading' || ins.status === 'idle') {
    replace(el, head, h('p', { class: 'loading', role: 'status' }, 'Inspecting this URL in Google’s index…'));
    return;
  }
  if (ins.status === 'error') {
    const e = ins.error;
    replace(el, head, h('p', { class: 'muted' }, `Index status unavailable: ${e?.message || 'unknown error'}`),
      e?.code === 'RATE_LIMITED' ? h('p', { class: 'hint' }, 'URL Inspection is limited to 2,000 checks per day per property.') : null);
    return;
  }
  const i = ins.data;
  const variant = { indexed: 'positive', excluded: 'notice', error: 'negative' }[i.status] || 'neutral';
  const findings = i.findings.filter((f) => f.code !== 'indexed');
  const crawl = i.lastCrawlTime
    ? `Last crawled ${i.lastCrawlDays !== null ? `${i.lastCrawlDays} day${i.lastCrawlDays === 1 ? '' : 's'} ago` : fmtDateTime(i.lastCrawlTime)}`
    : 'No successful crawl on record';
  replace(el,
    head,
    h('p', { class: 'index-status' }, statusLight(variant, inspectionHeadline(i)), h('span', { class: 'muted' }, crawl)),
    findings.length ? h('ul', { class: 'findings' }, findings.map((f) => {
      const v = f.canonical ? validateOverride(f.canonical, state.site) : null;
      return h('li', { class: `f-${f.level}` },
        h('span', { class: 'visually-hidden' }, `${f.level}: `), f.message,
        v?.ok && v.url !== state.pageUrl
          ? [' ', h('button', { class: 'link-button nx-action-btn-quiet nx-btn-sm', onclick: () => applyOverride(v.url) }, 'Use this URL')] : null);
    })) : null,
    h('details', { class: 'disclosure' },
      h('summary', {}, 'Index details'),
      h('dl', { class: 'evidence' },
        i.coverageState ? [h('dt', {}, 'Coverage'), h('dd', {}, i.coverageState)] : null,
        i.lastCrawlTime ? [h('dt', {}, 'Last crawl'), h('dd', {}, `${fmtDateTime(i.lastCrawlTime)}${i.crawledAs ? `, ${i.crawledAs.toLowerCase()} crawler` : ''}`)] : null,
        h('dt', {}, 'Google canonical'), h('dd', {}, i.googleCanonical
          ? `${i.googleCanonical}${i.canonical === 'self' ? ' (this URL)' : ''}` : 'None reported'),
        i.userCanonical ? [h('dt', {}, 'Declared canonical'), h('dd', {}, i.userCanonical)] : null,
        i.sitemaps.length ? [h('dt', {}, 'Sitemap'), h('dd', {}, i.sitemaps.join(', '))] : null,
        i.richResults?.types.length ? [h('dt', {}, 'Rich results'), h('dd', {}, i.richResults.types
          .map((t) => `${t.type}${t.errors ? ` (${t.errors} error${t.errors === 1 ? '' : 's'})` : t.warnings ? ` (${t.warnings} warning${t.warnings === 1 ? '' : 's'})` : ' (valid)'}`).join(', '))] : null),
      h('p', { class: 'hint' }, `From Google's last crawl, not a live test. Checked ${fmtDateTime(i.inspectedAt)}.`),
      i.link ? h('p', {}, h('a', { class: 'quiet-link', href: i.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Search Console')) : null));
}

function dataNotes(id, result) {
  const warnings = (result.warnings || []).map((w) => w.message).filter(Boolean);
  const f = result.freshness || {};
  const freshness = f.latestDate && id === 'google'
    ? `Data through ${fmtRangeShort({ start: f.latestDate, end: f.latestDate }).split(' – ')[0]}. Recent days appear once Google finalizes them.`
    : f.note;
  if (!freshness && !warnings.length) return null;
  return h('div', { class: 'data-notes' },
    warnings.map((w) => h('p', { class: 'hint' }, w)),
    freshness ? h('p', { class: 'hint' }, freshness) : null);
}

function opportunitiesSection(id, p) {
  const o = p.opps;
  if (!o || !o.cards.length) {
    return h('div', { class: 'opps' }, h('p', { class: 'muted' }, o?.reason || 'No opportunities flagged.'));
  }
  return h('div', { class: 'opps' },
    o.cards.map((card) => {
      const checked = p.selectedCards.has(card.id);
      const cbId = `card-${id}-${card.id.replace(/[^a-z0-9]/gi, '-')}`;
      return h('article', { class: `card ${card.strength}` },
        h('div', { class: 'card-head' },
          h('input', {
            type: 'checkbox', id: cbId, checked,
            'aria-label': `Include ${card.title} in the prompt`,
            onchange: (e) => { toggle(p.selectedCards, card.id, e.target.checked); renderPromptBar(id); },
          }),
          h('label', { for: cbId }, card.title),
          h('span', { class: `spectrum-badge is-${card.strength === 'review' ? 'notice' : 'neutral'}` }, card.strength === 'review' ? 'Review' : 'Consider')),
        h('p', { class: 'card-why' }, card.why),
        card.queries?.length > 1 ? h('p', { class: 'hint card-queries' }, `Main queries: ${card.queries.join(', ')}`) : null,
        card.checks?.length ? h('details', { class: 'disclosure card-checks' },
          h('summary', {}, `What to check (${card.checks.length})`),
          h('ul', {}, card.checks.map((c) => h('li', {}, c))),
          card.caveats?.length ? h('p', { class: 'caveat' }, card.caveats.join(' ')) : null) : null);
    }));
}

function toggle(set, key, on) {
  if (on) set.add(key); else set.delete(key);
}

function queriesSection(id, p) {
  const comp = p.result.comparison?.available;
  const tableWrap = h('div', { id: `table-${id}` });
  const search = h('input', {
    type: 'search', class: 'input nx-input', id: `q-search-${id}`, placeholder: 'Filter queries', value: p.search,
    oninput: (e) => { p.search = e.target.value; p.queryLimit = QUERY_BATCH_SIZE; renderTable(id, tableWrap); },
  });
  const filter = h('select', {
    class: 'nx-input',
    id: `q-filter-${id}`,
    onchange: (e) => { p.filter = e.target.value; p.queryLimit = QUERY_BATCH_SIZE; renderTable(id, tableWrap); },
  },
  h('option', { value: 'all', selected: p.filter === 'all' }, 'All queries'),
  h('option', { value: 'near', selected: p.filter === 'near' }, 'Position 8–20'),
  h('option', { value: 'lowctr', selected: p.filter === 'lowctr' }, 'CTR below page CTR'),
  comp ? h('option', { value: 'notprev', selected: p.filter === 'notprev' }, 'Not in previous rows') : null,
  h('option', { value: 'selected', selected: p.filter === 'selected' }, 'Selected only'));
  renderTable(id, tableWrap);
  return h('section', { class: 'queries' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Queries'), h('span', { class: 'count' }, fmtInt(p.result.queries.length))),
    h('div', { class: 'filters' },
      h('label', { class: 'visually-hidden', for: `q-search-${id}` }, 'Filter queries by text'), search,
      h('label', { class: 'visually-hidden', for: `q-filter-${id}` }, 'Show'), filter),
    tableWrap);
}

function sortHeader(id, p, key, label, numeric = true) {
  const active = p.sort.key === key;
  const ariaSort = active ? (p.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return h('th', { scope: 'col', 'aria-sort': ariaSort, class: numeric ? 'num' : '' },
    h('button', {
      class: 'sort',
      id: `sort-${id}-${key}`,
      onclick: () => {
        if (active) p.sort.dir = p.sort.dir === 'asc' ? 'desc' : 'asc';
        else p.sort = { key, dir: key === 'position' || key === 'query' ? 'asc' : 'desc' };
        p.queryLimit = QUERY_BATCH_SIZE;
        renderTable(id, document.getElementById(`table-${id}`));
      },
    }, label, active ? (p.sort.dir === 'asc' ? ' ↑' : ' ↓') : ''));
}

function prevLine(r, key, fmt) {
  if (r.previousStatus === 'present') return h('span', { class: 'prev' }, `was ${fmt(r.previous[key])}`);
  if (r.previousStatus === 'not-in-returned-rows') {
    return h('span', { class: 'prev', title: 'Not among the rows returned for the previous period (not the same as zero)' },
      'prev n/a', h('span', { class: 'visually-hidden' }, ': not among previous period rows'));
  }
  return null;
}

function renderTable(id, wrap) {
  const p = perProvider(id);
  const comp = p.result.comparison?.available;
  const { rows, total, hasMore } = queryWindow(p);
  const table = h('table', {},
    h('caption', { class: 'visually-hidden' }, `Search queries for ${p.result.requestedUrl}`),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', class: 'sel' }, h('span', { class: 'visually-hidden' }, 'Select for prompt')),
      sortHeader(id, p, 'query', 'Query', false),
      sortHeader(id, p, 'clicks', 'Clicks'),
      sortHeader(id, p, 'impressions', 'Impr.'),
      sortHeader(id, p, 'ctr', 'CTR'),
      p.result.metrics?.position?.available ? sortHeader(id, p, 'position', 'Pos.') : null)),
    h('tbody', {}, rows.length ? rows.map((r, i) => {
      const cb = `sel-${id}-${i}`;
      return h('tr', { class: p.selectedQueries.has(r.query) ? 'selected' : '' },
        h('td', { class: 'sel' }, h('input', {
          type: 'checkbox', id: cb, checked: p.selectedQueries.has(r.query),
          'aria-label': `Include “${r.query}” in the prompt`,
          onchange: (e) => {
            toggle(p.selectedQueries, r.query, e.target.checked);
            e.target.closest('tr').classList.toggle('selected', e.target.checked);
            renderPromptBar(id);
            if (p.filter === 'selected' && !e.target.checked) {
              renderTable(id, wrap);
              const next = document.getElementById(`sel-${id}-${i}`) || document.getElementById(`sel-${id}-${i - 1}`);
              (next || document.getElementById(`q-filter-${id}`))?.focus();
            }
          },
        })),
        h('th', { scope: 'row', class: 'q' }, r.query),
        h('td', { class: 'num' }, fmtInt(r.current.clicks), comp ? prevLine(r, 'clicks', fmtInt) : null),
        h('td', { class: 'num' }, fmtInt(r.current.impressions), comp ? prevLine(r, 'impressions', fmtInt) : null),
        h('td', { class: 'num' }, fmtPct(r.current.ctr)),
        p.result.metrics?.position?.available
          ? h('td', { class: 'num' }, fmtPos(r.current.position), comp && r.previousStatus === 'present' ? h('span', { class: 'prev' }, `was ${fmtPos(r.previous.position)}`) : null)
          : null);
    }) : h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No queries match.'))));
  const more = total > QUERY_BATCH_SIZE ? h('div', { class: 'query-pagination' },
    h('span', { class: 'hint' }, `Showing ${rows.length} of ${total} queries`),
    hasMore ? h('button', {
      type: 'button', class: 'button nx-form-btn-secondary',
      onclick: () => {
        const firstNewRow = p.queryLimit;
        p.queryLimit += QUERY_BATCH_SIZE;
        renderTable(id, wrap);
        document.getElementById(`sel-${id}-${firstNewRow}`)?.focus();
        announce(`Showing ${Math.min(p.queryLimit, total)} of ${total} queries.`);
      },
    }, 'Show more') : null) : null;
  replaceKeepingFocus(wrap, h('div', { class: 'table-wrap' }, table), more);
}

function selectedCards(p) {
  return (p.opps?.cards || []).filter((c) => p.selectedCards.has(c.id));
}

function selectionArea(id, p) {
  return h('div', { class: 'selection-scope' },
    h('h2', {}, 'Suggestions'),
    h('p', { class: 'hint' }, 'Select suggestions or queries, then review the prompt in Chat.'),
    promptBar(id, p),
    opportunitiesSection(id, p),
    queriesSection(id, p));
}

function promptBar(id, p) {
  const selected = p.selectedCards.size + p.selectedQueries.size;
  return h('div', { class: `prompt-bar${selected ? ' has-selection' : ''}`, id: `prompt-bar-${id}` },
    promptBarContent(id, p));
}

function renderPromptBar(id) {
  const el = document.getElementById(`prompt-bar-${id}`);
  if (!el) return;
  const p = perProvider(id);
  el.classList.toggle('has-selection', p.selectedCards.size + p.selectedQueries.size > 0);
  replaceKeepingFocus(el, promptBarContent(id, p));
}

function selectedPrompt(id, p) {
  return buildWorkspacePrompt(buildBrief({
    result: p.result,
    selectedQueries: [...p.selectedQueries],
    selectedCards: selectedCards(p),
    inspection: id === 'google' && p.inspection.status === 'ready' ? p.inspection.data : null,
  }));
}

function promptBarContent(id, p) {
  const nC = p.selectedCards.size;
  const nQ = p.selectedQueries.size;
  const selected = nC + nQ > 0;
  const summary = [
    nC ? `${nC} suggestion${nC === 1 ? '' : 's'}` : null,
    nQ ? `${nQ} quer${nQ === 1 ? 'y' : 'ies'}` : null,
  ].filter(Boolean);
  const canDraft = state.mode === 'live' && state.ws?.actions?.canSetPrompt;
  const status = h('p', { class: 'hint prompt-status', role: 'status' });
  return [
    h('div', { class: 'prompt-main' },
      h('p', { class: 'prompt-summary', role: 'status' }, selected ? `${summary.join(' and ')} selected` : 'Nothing selected'),
      h('button', {
        type: 'button', id: `draft-prompt-${id}`, class: 'button primary nx-btn-accent', disabled: !selected || !canDraft,
        onclick: () => {
          try {
            state.ws.actions.setPrompt(selectedPrompt(id, p));
            status.textContent = 'Request sent to Workspace. Review and send the prompt in Chat.';
          } catch {
            status.textContent = 'Could not open Chat. Reload Workspace and try again.';
          }
        },
      }, 'Ask in Chat')),
    !canDraft ? h('p', { class: 'hint' }, state.mode === 'demo'
      ? 'Chat is available in the live Workspace extension.'
      : 'Chat is unavailable in this version of Workspace.') : null,
    status,
  ];
}

function showDiagnostics() {
  return new URLSearchParams(location.search).has('debug');
}

function renderDiagnostics() {
  const ws = state.ws;
  return h('details', { class: 'disclosure diagnostics' },
    h('summary', {}, 'Diagnostics'),
    h('dl', {},
      h('dt', {}, 'Mode'), h('dd', {}, state.mode === 'demo' ? 'Demo (fixtures)' : 'Live'),
      h('dt', {}, 'Document'), h('dd', { class: 'mono' }, state.docPath || 'n/a'),
      h('dt', {}, 'Workspace context keys'), h('dd', { class: 'mono' }, ws ? ws.contextKeys.join(', ') : 'n/a'),
      h('dt', {}, 'Host capabilities'), h('dd', { class: 'mono' }, ws ? Object.keys(ws.capabilities).join(', ') || 'none' : 'n/a'),
      h('dt', {}, 'Site config'), h('dd', { class: 'mono' }, state.site ? `${state.site.id} → ${state.site.productionOrigin}` : 'n/a')));
}

boot();
