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
  const status = providerStatus(site({ bing: { siteUrl: 'https://x.dev/', auth: 'oauth' } }), {
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    BING_CLIENT_ID: 'id', BING_CLIENT_SECRET: 'secret',
  });
  assert.deepEqual(visibleProviders(status).map((p) => p.id), ['google', 'bing']);
  assert.equal(pickActive('bing', status), 'bing');
});

test('Bing is hidden without credentials, while unconfigured Google retains setup guidance', () => {
  const status = providerStatus(site({ bing: { siteUrl: 'https://x.dev/', auth: 'apiKey' } }), {});
  assert.equal(status.bing.configured, false);
  assert.deepEqual(visibleProviders(status).map((p) => p.id), ['google']);
  assert.equal(pickActive('bing', status), 'google');
});

test('Bing with an API key is visible so it can be used', () => {
  const status = providerStatus(site({ bing: { siteUrl: 'https://x.dev/', auth: 'apiKey' } }), { BING_API_KEY: 'key' });
  assert.deepEqual(visibleProviders(status).map((p) => p.id), ['google', 'bing']);
});

test('Bing OAuth needs both deployment credentials before its tab appears', () => {
  const bingSite = site({ bing: { siteUrl: 'https://x.dev/', auth: 'oauth' } });
  const incomplete = providerStatus(bingSite, { BING_CLIENT_ID: 'id' });
  assert.deepEqual(visibleProviders(incomplete).map((p) => p.id), ['google']);
  const complete = providerStatus(bingSite, { BING_CLIENT_ID: 'id', BING_CLIENT_SECRET: 'secret' });
  assert.deepEqual(visibleProviders(complete).map((p) => p.id), ['google', 'bing']);
});

test('Bing alone without credentials leaves no active provider', () => {
  const status = providerStatus({
    id: 's', da: { org: 'o', site: 's' }, productionOrigin: 'https://x.dev',
    bing: { siteUrl: 'https://x.dev/', auth: 'oauth' },
  }, {});
  assert.deepEqual(visibleProviders(status), []);
  assert.equal(pickActive('bing', status), null);
});

test('no providers enabled -> no active tab', () => {
  const status = providerStatus({ id: 's', da: { org: 'o', site: 's' }, productionOrigin: 'https://x.dev' }, {});
  assert.deepEqual(visibleProviders(status), []);
  assert.equal(pickActive('google', status), null);
});
