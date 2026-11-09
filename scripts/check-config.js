#!/usr/bin/env node
/* Validate SITES in wrangler.jsonc (or a file passed as argument). */
import { readFileSync } from 'node:fs';
import { loadSites } from '../worker/config.js';

const file = process.argv[2] || 'wrangler.jsonc';
const text = readFileSync(file, 'utf8')
  // strip // and /* */ comments outside strings
  .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
  .replace(/,(\s*[}\]])/g, '$1');
const cfg = JSON.parse(text);
try {
  const sites = loadSites(cfg.vars || {});
  sites.forEach((s) => console.log(`✓ ${s.id}: ${s.da.org}/${s.da.site} → ${s.productionOrigin}`
    + `${s.google ? ` | google ${s.google.properties.join(', ')}` : ''}${s.bing ? ` | bing ${s.bing.siteUrl} (${s.bing.auth})` : ''}`));
  console.log('Secrets are not checked here. Verify with: npx wrangler secret list');
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
