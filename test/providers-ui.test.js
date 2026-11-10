import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleProviders, pickActive } from '../web/ui/providers.js';
import { providerStatus } from '../worker/config.js';

const site = (extra) => ({ id: 's', da: { org: 'o', site: 's' }, productionOrigin: 'https://x.dev', google: { properties: ['sc-domain:x.dev'] }, ...extra });

test('a site without a bing section shows only the Google tab', () => {
  const status = providerStatus(site(), {});
  assert.deepEqual(visibleProviders(status).map((p) => p.id), ['google']);
  assert.equal(pickActive('bing', status), 'google');
});

test('both providers visible when both are configured; current tab is kept', () => {
  const status = providerStatus(site({ bing: { siteUrl: 'https://x.dev/', auth: 'oauth' } }), {});
  assert.deepEqual(visibleProviders(status).map((p) => p.id), ['google', 'bing']);
  assert.equal(pickActive('bing', status), 'bing');
});

test('enabled but not yet configured providers stay visible (they show setup guidance)', () => {
  const status = providerStatus(site({ bing: { siteUrl: 'https://x.dev/', auth: 'apiKey' } }), {});
  assert.equal(status.bing.configured, false);
  assert.ok(visibleProviders(status).some((p) => p.id === 'bing'));
});

test('no providers enabled -> no active tab', () => {
  const status = providerStatus({ id: 's', da: { org: 'o', site: 's' }, productionOrigin: 'https://x.dev' }, {});
  assert.deepEqual(visibleProviders(status), []);
  assert.equal(pickActive('google', status), null);
});
