import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePublicUrl, validateOverride, isUrlInGoogleProperty, isUrlInBingSite, compareCanonical,
  documentPathToPublicPath, parseAemHost,
} from '../web/core/url-resolver.js';

const SITE = {
  id: 'edgepatterns',
  da: { org: 'samircaus', site: 'da-elsie' },
  productionOrigin: 'https://edgepatterns.dev',
};
const ctx = (path) => ({ org: 'samircaus', site: 'da-elsie', path });

test('root index maps to origin root', () => {
  assert.equal(resolvePublicUrl(ctx('/index'), SITE).url, 'https://edgepatterns.dev/');
  assert.equal(resolvePublicUrl(ctx('/'), SITE).url, 'https://edgepatterns.dev/');
});

test('nested index maps to folder with trailing slash (EDS convention)', () => {
  assert.equal(resolvePublicUrl(ctx('/de/index'), SITE).url, 'https://edgepatterns.dev/de/');
});

test('nested pages have no extension or trailing slash', () => {
  assert.equal(resolvePublicUrl(ctx('/martech/fpid'), SITE).url, 'https://edgepatterns.dev/martech/fpid');
  assert.equal(resolvePublicUrl(ctx('martech/fpid'), SITE).url, 'https://edgepatterns.dev/martech/fpid');
});

test('.html extension is stripped', () => {
  const r = resolvePublicUrl(ctx('/about.html'), SITE);
  assert.equal(r.url, 'https://edgepatterns.dev/about');
  assert.ok(r.notes.some((n) => n.includes('.html')));
});

test('sheets and media are not pages', () => {
  assert.equal(resolvePublicUrl(ctx('/query-index.json'), SITE).status, 'excluded');
  assert.equal(resolvePublicUrl(ctx('/media/hero.png'), SITE).reason, 'not-a-page');
});

test('drafts, tools, nav and footer are excluded', () => {
  assert.equal(resolvePublicUrl(ctx('/drafts/samir/test'), SITE).reason, 'not-public');
  assert.equal(resolvePublicUrl(ctx('/tools/tags'), SITE).reason, 'not-public');
  assert.equal(resolvePublicUrl(ctx('/nav'), SITE).reason, 'not-public');
  assert.equal(resolvePublicUrl(ctx('/footer'), SITE).reason, 'not-public');
});

test('encoded and unencoded paths are encoded exactly once', () => {
  assert.equal(resolvePublicUrl(ctx('/blog/caf%C3%A9'), SITE).url, 'https://edgepatterns.dev/blog/caf%C3%A9');
  assert.equal(resolvePublicUrl(ctx('/blog/café'), SITE).url, 'https://edgepatterns.dev/blog/caf%C3%A9');
  assert.equal(resolvePublicUrl(ctx('/a b'), SITE).url, 'https://edgepatterns.dev/a%20b');
});

test('uppercase paths require confirmation', () => {
  const r = resolvePublicUrl(ctx('/Martech/FPID'), SITE);
  assert.equal(r.status, 'needs-confirmation');
  assert.equal(r.url, 'https://edgepatterns.dev/Martech/FPID');
});

test('path mappings are applied after index handling', () => {
  const site = { ...SITE, paths: { mappings: [{ from: '/en/', to: '/' }] } };
  assert.equal(resolvePublicUrl(ctx('/en/products/x'), site).url, 'https://edgepatterns.dev/products/x');
  assert.equal(resolvePublicUrl(ctx('/en/index'), site).url, 'https://edgepatterns.dev/');
});

test('trailing slash policy "always"', () => {
  const site = { ...SITE, paths: { trailingSlash: 'always' } };
  assert.equal(resolvePublicUrl(ctx('/about'), site).url, 'https://edgepatterns.dev/about/');
});

test('document from another DA site is not resolved', () => {
  const r = resolvePublicUrl({ org: 'other', site: 'x', path: '/about' }, SITE);
  assert.equal(r.status, 'needs-confirmation');
  assert.equal(r.reason, 'site-mismatch');
});

test('missing path asks for confirmation', () => {
  assert.equal(documentPathToPublicPath('', SITE).status, 'needs-confirmation');
});

test('production origin never comes from plugin host', () => {
  // resolvePublicUrl has no access to window/location; origin comes from config only.
  const r = resolvePublicUrl(ctx('/about'), { ...SITE, productionOrigin: 'https://www.example.org/' });
  assert.equal(r.url, 'https://www.example.org/about');
});

test('override: accepts production URLs and bare paths', () => {
  assert.deepEqual(validateOverride('/about', SITE).url, 'https://edgepatterns.dev/about');
  assert.equal(validateOverride('https://edgepatterns.dev/de/', SITE).url, 'https://edgepatterns.dev/de/');
});

test('override: strips query string and hash', () => {
  const v = validateOverride('https://edgepatterns.dev/about?utm=x#top', SITE);
  assert.equal(v.url, 'https://edgepatterns.dev/about');
  assert.ok(v.notes.length);
});

test('override: maps preview and live branch hosts of this site', () => {
  assert.equal(validateOverride('https://main--da-elsie--samircaus.aem.page/about', SITE).url, 'https://edgepatterns.dev/about');
  assert.equal(validateOverride('https://feat-x--da-elsie--samircaus.aem.live/labs', SITE).url, 'https://edgepatterns.dev/labs');
});

test('override: rejects other origins, other sites, http and credentials', () => {
  assert.equal(validateOverride('https://evil.example/about', SITE).reason, 'origin-not-allowed');
  assert.equal(validateOverride('https://main--other--org.aem.page/about', SITE).reason, 'other-site');
  assert.equal(validateOverride('http://edgepatterns.dev/about', SITE).reason, 'origin-not-allowed');
  assert.equal(validateOverride('https://user:pw@edgepatterns.dev/', SITE).reason, 'credentials-not-allowed');
  assert.equal(validateOverride('https://edgepatterns.dev.evil.example/', SITE).reason, 'origin-not-allowed');
  assert.equal(validateOverride('not a url', SITE).reason, 'invalid-url');
});

test('parseAemHost', () => {
  assert.deepEqual(parseAemHost('main--da-elsie--samircaus.aem.page'), {
    branch: 'main', site: 'da-elsie', org: 'samircaus', tier: 'page',
  });
  assert.equal(parseAemHost('edgepatterns.dev'), null);
});

test('Google property coverage: domain and URL-prefix', () => {
  assert.ok(isUrlInGoogleProperty('https://edgepatterns.dev/a', 'sc-domain:edgepatterns.dev'));
  assert.ok(isUrlInGoogleProperty('https://www.edgepatterns.dev/a', 'sc-domain:edgepatterns.dev'));
  assert.ok(!isUrlInGoogleProperty('https://notedgepatterns.dev/a', 'sc-domain:edgepatterns.dev'));
  assert.ok(isUrlInGoogleProperty('https://edgepatterns.dev/a', 'https://edgepatterns.dev/'));
  assert.ok(!isUrlInGoogleProperty('https://edgepatterns.dev/a', 'https://edgepatterns.dev/blog/'));
});

test('Bing site coverage by origin', () => {
  assert.ok(isUrlInBingSite('https://edgepatterns.dev/a', 'https://edgepatterns.dev/'));
  assert.ok(!isUrlInBingSite('https://other.dev/a', 'https://edgepatterns.dev/'));
});

test('canonical comparison', () => {
  const u = 'https://edgepatterns.dev/about';
  assert.equal(compareCanonical(u, 'https://edgepatterns.dev/about', SITE).status, 'match');
  assert.equal(compareCanonical(u, '/about', SITE).status, 'match');
  const d = compareCanonical(u, 'https://edgepatterns.dev/about-us', SITE);
  assert.equal(d.status, 'differs');
  assert.equal(d.canonical, 'https://edgepatterns.dev/about-us');
  assert.equal(compareCanonical(u, 'https://other.example/about', SITE).status, 'other-origin');
  assert.equal(compareCanonical(u, null, SITE).status, 'none');
});
