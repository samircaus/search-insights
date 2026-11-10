/**
 * Search Insights — Experience Workspace library plugin.
 * "What brings people to this page, what has changed, and what should I review?"
 */
import { connectWorkspace } from './workspace.js';
import { createApi, ApiError } from './api.js';
import { createDemoApi, DEMO_PAGES } from './fixtures/demo.js';
import { resolvePublicUrl, validateOverride } from './core/url-resolver.js';
import { findOpportunities, mergeThresholds } from './core/opportunities.js';
import { buildBrief, briefToHtml } from './core/brief.js';
import { inspectionHeadline } from './core/inspection.js';
import { fmtRange } from './core/dates.js';
import {
  fmtInt, fmtPct, fmtPos, fmtRelChange, fmtPp, changeDirection, isNum,
} from './core/metrics.js';
import { h, announce, replace } from './ui/dom.js';

const PROVIDERS = [
  { id: 'google', label: 'Google', long: 'Google Search Console' },
  { id: 'bing', label: 'Bing', long: 'Bing Webmaster Tools' },
];

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
};

function perProvider(id) {
  if (!state.per[id]) {
    state.per[id] = {
      status: 'idle', result: null, error: null, opps: null,
      selectedQueries: new Set(), selectedCards: new Set(),
      inspection: { status: 'idle', data: null, error: null },
      sort: { key: 'clicks', dir: 'desc' }, filter: 'all', search: '',
      briefFormat: 'markdown', brief: null, confirmInsert: false,
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
  if (params.has('demo')) return startDemo(params.get('page'));

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
  state.api = createDemoApi();
  const cfg = await state.api.config();
  state.site = cfg.site;
  state.providers = cfg.providers;
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
      days: state.site.reportingDays,
      refresh,
    });
    if (reqUrl !== state.pageUrl) return;
    p.result = result;
    p.opps = findOpportunities(result, mergeThresholds(state.site.thresholds || {}));
    p.status = result.hasData ? 'ready' : 'empty';
    p.brief = null;
    announce(`${labelOf(id)} data loaded.`);
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
  if (p.brief) renderBriefOnly('google');
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
      h('a', { class: 'button primary', href: '?demo' }, 'Explore with demo data'))));
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
    renderDiagnostics());
  renderIdentity();
  renderTabs();
  renderPanel();
}

function badge() {
  return state.mode === 'demo'
    ? h('span', { class: 'badge demo', title: 'Fictional fixture data for demonstration' }, 'Demo data')
    : h('span', { class: 'badge live', title: 'Data is requested live from the providers' }, 'Live data');
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
      id: 'demo-page',
      onchange: (e) => startDemo(e.target.value),
    }, DEMO_PAGES.map((p) => h('option', { value: p.path, selected: p.path === state.docPath }, p.label)));
    children.push(h('div', { class: 'field' }, h('label', { for: 'demo-page' }, 'Demo page'), sel));
  }
  children.push(h('dl', { class: 'page-id' },
    h('dt', {}, 'Document'), h('dd', { class: 'mono' }, state.docPath || '—'),
    h('dt', {}, 'Public URL'),
    h('dd', {}, state.pageUrl
      ? h('a', { href: state.pageUrl, target: '_blank', rel: 'noopener noreferrer', class: 'url' }, state.pageUrl)
      : h('span', { class: 'muted' }, resolutionMessage(r)))));

  if (r.status === 'needs-confirmation' && r.url) {
    children.push(h('div', { class: 'notice' },
      h('p', {}, `Please confirm the public URL: ${r.url}`),
      h('button', { class: 'button', onclick: () => applyOverride(r.url) }, 'Use this URL')));
  }
  (r.notes || []).forEach((n) => children.push(h('p', { class: 'hint' }, n)));
  const pc = state.pageCheck;
  if (pc) children.push(pageCheckNotice(pc));

  children.push(h('button', {
    class: 'link-button', 'aria-expanded': String(state.showOverride),
    onclick: () => { state.showOverride = !state.showOverride; renderIdentity(); },
  }, state.showOverride ? 'Cancel URL change' : 'Use a different URL'));
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
      h('button', { class: 'button', onclick: () => applyOverride(pc.canonical.canonical) }, 'Use canonical URL'));
  }
  if (pc.status === 'ok' && pc.redirected) {
    return h('p', { class: 'hint' }, `This URL redirects to ${pc.finalUrl}.`);
  }
  if (pc.status === 'not-found') {
    return h('p', { class: 'notice' }, 'This URL is not published (404). New or unpublished pages have no search data yet.');
  }
  if (pc.status === 'ok') return h('p', { class: 'hint ok' }, 'Published page found; canonical URL matches.');
  if (pc.status === 'check-failed') return null;
  return h('p', { class: 'hint' }, `Published page check: ${pc.status}.`);
}

function overrideForm() {
  const input = h('input', {
    id: 'override', type: 'url', class: 'input', placeholder: `${state.site.productionOrigin}/path`, value: state.pageUrl || '',
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
  h('button', { class: 'button primary', type: 'submit' }, 'Apply'));
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
  replace(el, PROVIDERS.map((p, i) => {
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
          const next = PROVIDERS[(i + (e.key === 'ArrowRight' ? 1 : PROVIDERS.length - 1)) % PROVIDERS.length];
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
  document.getElementById('panel')?.setAttribute('aria-labelledby', `tab-${id}`);
  renderTabs();
  const p = perProvider(id);
  if (p.status === 'ready' || p.status === 'empty' || p.status === 'loading') renderPanel();
  else loadActive();
}

function renderPanel() {
  const el = document.getElementById('panel');
  if (!el) return;
  el.setAttribute('aria-labelledby', `tab-${state.active}`);
  const id = state.active;
  const p = perProvider(id);
  const parts = [connectionBar(id, p)];

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
      parts.push(h('p', { class: 'loading', role: 'status' }, `Loading ${labelOf(id)} data…`));
      break;
    case 'error':
      parts.push(errorBox(id, p.error));
      break;
    case 'empty':
      parts.push(periodBar(p.result), inspectionSlot(id), noDataBox(id, p.result));
      break;
    case 'ready':
      parts.push(
        periodBar(p.result),
        inspectionSlot(id),
        summaryTiles(p.result),
        warningsList(p.result),
        opportunitiesSection(id, p),
        queriesSection(id, p),
        briefSection(id, p),
      );
      break;
    default:
      parts.push(h('p', { class: 'loading' }, 'Preparing…'));
  }
  replace(el, parts);
}

function connectionBar(id, p) {
  const conn = state.connections?.[id];
  const bits = [];
  if (conn?.connected) {
    bits.push(h('span', { class: 'conn ok' }, `Connected${conn.account ? ` as ${conn.account}` : ''}`));
    if (state.mode === 'live' && state.providers?.[id]?.auth === 'oauth') {
      bits.push(h('button', { class: 'link-button', onclick: () => disconnectProvider(id) }, 'Disconnect'));
    }
    if (p.status === 'ready' || p.status === 'empty') {
      bits.push(h('button', { class: 'link-button', onclick: () => loadActive({ refresh: true }) }, 'Refresh'));
    }
  }
  if (id === 'google' && conn?.connected && Array.isArray(state.properties) && state.properties.length > 1) {
    const sel = h('select', {
      id: 'property',
      onchange: (e) => { state.property = e.target.value; perProvider('google').result = null; loadActive(); },
    }, state.properties.map((pr) => h('option', {
      value: pr.property, selected: pr.property === state.property, disabled: !pr.accessible,
    }, `${pr.property}${pr.accessible ? '' : ' (no access)'}`)));
    bits.push(h('span', { class: 'field inline' }, h('label', { for: 'property' }, 'Property'), sel));
  }
  return h('div', { class: 'conn-bar' }, bits);
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
      : h('button', { class: 'button primary', onclick: () => connect(id) }, conn?.reauth ? 'Reconnect' : `Connect ${labelOf(id)}`),
    p.popupLink ? h('p', {}, 'Your browser blocked the sign-in window. ',
      h('a', { href: p.popupLink, target: '_blank', rel: 'noopener' }, 'Open the sign-in page')) : null,
    state.mode === 'demo' ? h('p', { class: 'hint' }, 'Connections are simulated in demo mode.') : null);
}

function errorBox(id, e) {
  const code = e instanceof ApiError ? e.code : 'INTERNAL';
  const actions = [];
  if (code === 'REAUTH_REQUIRED' || code === 'NOT_CONNECTED') {
    actions.push(h('button', { class: 'button primary', onclick: () => connect(id) }, 'Reconnect'));
  } else if (['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'NETWORK', 'INTERNAL'].includes(code)) {
    actions.push(h('button', { class: 'button', onclick: () => loadActive({ refresh: true }) }, 'Try again'));
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
    h('p', { class: 'hint' }, 'New or recently published pages often take days to weeks to appear. Check that the URL above is the one search engines index (see the canonical check).'),
    warningsList(result));
}

function periodBar(result) {
  const p = result.periods || {};
  const gran = p.granularity === 'week' ? ' (weekly Bing rows)' : '';
  return h('div', { class: 'period' },
    h('p', {}, h('strong', {}, 'Period: '), p.current ? fmtRange(p.current) : '—', gran),
    h('p', {}, h('strong', {}, 'Compared with: '),
      result.comparison?.available && p.previous ? fmtRange(p.previous) : (result.comparison?.reason || 'No comparison available.')),
    result.freshness?.note ? h('p', { class: 'hint' }, result.freshness.note) : null);
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
    if (change.direction === 'improved') return { text: `▲ improved ${abs}`, dir: 'good' };
    if (change.direction === 'declined') return { text: `▼ worse by ${abs}`, dir: 'bad' };
    return { text: 'unchanged', dir: 'flat' };
  }
  const dir = changeDirection(change);
  const arrow = dir === 'up' ? '▲ ' : dir === 'down' ? '▼ ' : '';
  return { text: `${arrow}${fmtRelChange(change)}`, dir };
}

function tile(label, value, change, sr) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-label' }, label),
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
      comp ? 'Average position change; lower is better' : undefined));
  }
  return h('section', { class: 'summary', 'aria-label': 'Performance summary' },
    h('div', { class: 'tiles' }, tiles),
    s.source === 'derived-from-query-rows' ? h('p', { class: 'hint' }, 'Totals are summed from returned query rows (see warnings).') : null,
    result.metrics?.position?.definition ? h('p', { class: 'hint' }, `Position: ${result.metrics.position.definition}`) : null);
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
  const head = h('h2', {}, 'Google index status');
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
  const icon = { indexed: '✓', excluded: '!', error: '✕' }[i.status] || '?';
  const findings = i.findings.filter((f) => f.code !== 'indexed');
  replace(el,
    head,
    h('p', { class: `index-status s-${i.status}` },
      h('span', { 'aria-hidden': 'true' }, `${icon} `), h('strong', {}, inspectionHeadline(i)),
      i.coverageState ? ` — ${i.coverageState}` : ''),
    h('dl', { class: 'evidence' },
      h('dt', {}, 'Last crawl'), h('dd', {}, i.lastCrawlTime
        ? `${fmtDateTime(i.lastCrawlTime)}${i.lastCrawlDays !== null ? ` (${i.lastCrawlDays} day${i.lastCrawlDays === 1 ? '' : 's'} ago)` : ''}${i.crawledAs ? `, ${i.crawledAs.toLowerCase()} crawler` : ''}`
        : 'No successful crawl on record'),
      h('dt', {}, 'Google canonical'), h('dd', { class: 'mono' }, i.googleCanonical
        ? `${i.googleCanonical}${i.canonical === 'self' ? ' (this URL)' : ''}` : '—'),
      i.userCanonical ? [h('dt', {}, 'Declared canonical'), h('dd', { class: 'mono' }, i.userCanonical)] : null,
      i.sitemaps.length ? [h('dt', {}, 'In sitemap'), h('dd', { class: 'mono' }, i.sitemaps.join(', '))] : null,
      i.richResults?.types.length ? [h('dt', {}, 'Rich results'), h('dd', {}, i.richResults.types
        .map((t) => `${t.type}${t.errors ? ` (${t.errors} error${t.errors === 1 ? '' : 's'})` : t.warnings ? ` (${t.warnings} warning${t.warnings === 1 ? '' : 's'})` : ' (valid)'}`).join(', '))] : null),
    findings.length ? h('ul', { class: 'findings' }, findings.map((f) => {
      const v = f.canonical ? validateOverride(f.canonical, state.site) : null;
      return h('li', { class: `f-${f.level}` },
        h('span', { class: 'visually-hidden' }, `${f.level}: `), f.message,
        v?.ok && v.url !== state.pageUrl
          ? [' ', h('button', { class: 'link-button', onclick: () => applyOverride(v.url) }, 'Use this URL')] : null);
    })) : null,
    h('p', { class: 'hint' },
      `Reflects Google’s indexed version, not a live test. Checked ${fmtDateTime(i.inspectedAt)}. `,
      i.link ? h('a', { href: i.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Search Console') : null));
}

function warningsList(result) {
  if (!result.warnings?.length) return null;
  return h('details', { class: 'warnings' },
    h('summary', {}, `Data notes (${result.warnings.length})`),
    h('ul', {}, result.warnings.map((w) => h('li', {}, w.message))));
}

function opportunitiesSection(id, p) {
  const o = p.opps;
  const head = h('h2', {}, 'What to review');
  if (!o || !o.cards.length) {
    return h('section', { class: 'opps' }, head, h('p', { class: 'muted' }, o?.reason || 'No opportunities flagged.'));
  }
  return h('section', { class: 'opps' }, head,
    h('p', { class: 'hint' }, 'Flagged by transparent rules. Select items to include in the editing brief.'),
    o.cards.map((card) => {
      const checked = p.selectedCards.has(card.id);
      const cbId = `card-${id}-${card.id.replace(/[^a-z0-9]/gi, '-')}`;
      return h('article', { class: `card ${card.strength}` },
        h('div', { class: 'card-head' },
          h('input', {
            type: 'checkbox', id: cbId, checked,
            onchange: (e) => { toggle(p.selectedCards, card.id, e.target.checked); renderBriefOnly(id); },
          }),
          h('label', { for: cbId }, h('span', { class: 'card-kind' }, card.strength === 'review' ? 'Review' : 'Consider'), ' ', card.title)),
        h('p', {}, card.why),
        h('details', {},
          h('summary', {}, 'Evidence and checks'),
          h('dl', { class: 'evidence' }, card.evidence.map((e) => [h('dt', {}, e.label), h('dd', {}, e.value)])),
          h('p', { class: 'hint' }, `Dates: ${fmtRange(card.dates.current)}${card.dates.previous ? ` vs ${fmtRange(card.dates.previous)}` : ''}`),
          h('h3', {}, 'Suggested checks'),
          h('ul', {}, card.checks.map((c) => h('li', {}, c))),
          h('p', { class: 'caveat' }, card.caveats.join(' '))));
    }));
}

function toggle(set, key, on) {
  if (on) set.add(key); else set.delete(key);
}

const SORTS = {
  query: (r) => r.query.toLowerCase(),
  clicks: (r) => r.current.clicks ?? -1,
  impressions: (r) => r.current.impressions ?? -1,
  ctr: (r) => r.current.ctr ?? -1,
  position: (r) => r.current.position ?? Infinity,
  delta: (r) => (r.previousStatus === 'present' ? r.current.clicks - r.previous.clicks : -Infinity),
};

function filteredRows(p) {
  const pageCtr = p.result.summary.current.ctr;
  const term = p.search.trim().toLowerCase();
  let rows = p.result.queries.filter((r) => !term || r.query.toLowerCase().includes(term));
  if (p.filter === 'near') rows = rows.filter((r) => isNum(r.current.position) && r.current.position >= 8 && r.current.position <= 20);
  if (p.filter === 'lowctr') rows = rows.filter((r) => isNum(r.current.ctr) && isNum(pageCtr) && r.current.ctr < pageCtr && r.current.impressions >= 20);
  if (p.filter === 'notprev') rows = rows.filter((r) => r.previousStatus === 'not-in-returned-rows');
  if (p.filter === 'selected') rows = rows.filter((r) => p.selectedQueries.has(r.query));
  const fn = SORTS[p.sort.key];
  const dir = p.sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = fn(a); const y = fn(b);
    return x < y ? -dir : x > y ? dir : 0;
  });
}

function queriesSection(id, p) {
  const comp = p.result.comparison?.available;
  const tableWrap = h('div', { class: 'table-wrap', id: `table-${id}` });
  const search = h('input', {
    type: 'search', class: 'input', id: `q-search-${id}`, placeholder: 'Filter queries', value: p.search,
    oninput: (e) => { p.search = e.target.value; renderTable(id, tableWrap); },
  });
  const filter = h('select', {
    id: `q-filter-${id}`,
    onchange: (e) => { p.filter = e.target.value; renderTable(id, tableWrap); },
  },
  h('option', { value: 'all', selected: p.filter === 'all' }, 'All queries'),
  h('option', { value: 'near', selected: p.filter === 'near' }, 'Position 8–20'),
  h('option', { value: 'lowctr', selected: p.filter === 'lowctr' }, 'CTR below page CTR'),
  comp ? h('option', { value: 'notprev', selected: p.filter === 'notprev' }, 'Not in previous rows') : null,
  h('option', { value: 'selected', selected: p.filter === 'selected' }, 'Selected only'));
  renderTable(id, tableWrap);
  return h('section', { class: 'queries' },
    h('h2', {}, `Queries (${p.result.queries.length} returned)`),
    h('p', { class: 'hint' }, `${labelOf(id)} returns top queries only; this is not complete keyword coverage.`),
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
      onclick: () => {
        if (active) p.sort.dir = p.sort.dir === 'asc' ? 'desc' : 'asc';
        else p.sort = { key, dir: key === 'position' || key === 'query' ? 'asc' : 'desc' };
        renderTable(id, document.getElementById(`table-${id}`));
      },
    }, label, active ? (p.sort.dir === 'asc' ? ' ↑' : ' ↓') : ''));
}

function prevLine(r, key, fmt) {
  if (r.previousStatus === 'present') return h('span', { class: 'prev' }, `was ${fmt(r.previous[key])}`);
  if (r.previousStatus === 'not-in-returned-rows') {
    return h('span', { class: 'prev', title: 'Not among the rows returned for the previous period (not the same as zero)' },
      'prev —', h('span', { class: 'visually-hidden' }, ': not among previous period rows'));
  }
  return null;
}

function renderTable(id, wrap) {
  const p = perProvider(id);
  const comp = p.result.comparison?.available;
  const rows = filteredRows(p);
  const table = h('table', {},
    h('caption', { class: 'visually-hidden' }, `Search queries for ${p.result.requestedUrl}`),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', class: 'sel' }, h('span', { class: 'visually-hidden' }, 'Select for brief')),
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
          'aria-label': `Select “${r.query}” for the brief`,
          onchange: (e) => {
            toggle(p.selectedQueries, r.query, e.target.checked);
            e.target.closest('tr').classList.toggle('selected', e.target.checked);
            renderBriefOnly(id);
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
  replace(wrap, table);
}

function selectedCards(p) {
  return (p.opps?.cards || []).filter((c) => p.selectedCards.has(c.id));
}

function briefSection(id, p) {
  return h('section', { class: 'brief', id: `brief-${id}` }, briefContent(id, p));
}

function renderBriefOnly(id) {
  const el = document.getElementById(`brief-${id}`);
  const p = perProvider(id);
  p.brief = null;
  p.confirmInsert = false;
  if (el) replace(el, briefContent(id, p));
}

function briefContent(id, p) {
  const nQ = p.selectedQueries.size;
  const nC = p.selectedCards.size;
  const parts = [h('h2', {}, 'Editing brief')];
  if (!nQ && !nC) {
    parts.push(h('p', { class: 'muted' }, 'Select queries or flagged items above to build a brief.'));
    return parts;
  }
  parts.push(h('p', {}, `${nC} flagged item${nC === 1 ? '' : 's'} and ${nQ} quer${nQ === 1 ? 'y' : 'ies'} selected.`));
  if (!p.brief) {
    parts.push(h('button', {
      class: 'button primary',
      onclick: () => {
        p.brief = buildBrief({
          result: p.result,
          selectedQueries: [...p.selectedQueries],
          selectedCards: selectedCards(p),
          inspection: id === 'google' && p.inspection.status === 'ready' ? p.inspection.data : null,
        });
        replace(document.getElementById(`brief-${id}`), briefContent(id, p));
        document.getElementById(`brief-text-${id}`)?.focus();
      },
    }, 'Preview brief'));
    return parts;
  }
  const text = p.briefFormat === 'markdown' ? p.brief.markdown : p.brief.text;
  const status = h('p', { class: 'hint', role: 'status', id: `copy-status-${id}` });
  parts.push(
    h('div', { class: 'format', role: 'radiogroup', 'aria-label': 'Brief format' },
      ['markdown', 'text'].map((f) => h('label', {},
        h('input', {
          type: 'radio', name: `fmt-${id}`, value: f, checked: p.briefFormat === f,
          onchange: () => { p.briefFormat = f; replace(document.getElementById(`brief-${id}`), briefContent(id, p)); },
        }), f === 'markdown' ? ' Markdown' : ' Plain text'))),
    h('label', { for: `brief-text-${id}`, class: 'visually-hidden' }, 'Brief preview'),
    h('textarea', { id: `brief-text-${id}`, class: 'brief-text', readonly: true, rows: '14' }, text),
    h('div', { class: 'row' },
      h('button', { class: 'button primary', onclick: () => copyText(text, status, id) }, 'Copy brief'),
      state.ws?.actions?.canInsertHtml && state.mode === 'live'
        ? h('button', { class: 'button', onclick: () => { p.confirmInsert = true; replace(document.getElementById(`brief-${id}`), briefContent(id, p)); } }, 'Insert into document…')
        : null),
    status);
  if (p.confirmInsert) {
    parts.push(h('div', { class: 'notice', role: 'alertdialog', 'aria-labelledby': `ins-${id}` },
      h('p', { id: `ins-${id}` }, 'This adds the brief as author-facing text at your cursor position in the document. It does not save, preview or publish. Remove it before publishing.'),
      h('div', { class: 'row' },
        h('button', {
          class: 'button primary',
          onclick: () => {
            state.ws.actions.insertHtml(briefToHtml(p.brief));
            p.confirmInsert = false;
            replace(document.getElementById(`brief-${id}`), briefContent(id, p));
            announce('Brief sent to the document at the cursor position.');
          },
        }, 'Insert brief'),
        h('button', { class: 'button', onclick: () => { p.confirmInsert = false; replace(document.getElementById(`brief-${id}`), briefContent(id, p)); } }, 'Cancel'))));
  }
  return parts;
}

async function copyText(text, statusEl, id) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.getElementById(`brief-text-${id}`);
    if (ta) {
      ta.focus();
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
  }
  statusEl.textContent = ok ? 'Brief copied to the clipboard.' : 'Copy failed. Select the text above and copy it manually.';
}

function renderDiagnostics() {
  const ws = state.ws;
  return h('details', { class: 'diagnostics' },
    h('summary', {}, 'Diagnostics'),
    h('dl', {},
      h('dt', {}, 'Mode'), h('dd', {}, state.mode === 'demo' ? 'Demo (fixtures)' : 'Live'),
      h('dt', {}, 'Workspace context keys'), h('dd', { class: 'mono' }, ws ? ws.contextKeys.join(', ') : 'n/a'),
      h('dt', {}, 'Host capabilities'), h('dd', { class: 'mono' }, ws ? Object.keys(ws.capabilities).join(', ') || 'none' : 'n/a'),
      h('dt', {}, 'Insert available'), h('dd', {}, ws?.actions?.canInsertHtml ? 'yes (sendHTML)' : 'no'),
      h('dt', {}, 'Site config'), h('dd', { class: 'mono' }, state.site ? `${state.site.id} → ${state.site.productionOrigin}` : 'n/a')));
}

boot();
