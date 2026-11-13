import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Workspace styles and fonts are allowed without broadening script or frame origins', async () => {
  const [html, headers] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/_headers', import.meta.url), 'utf8'),
  ]);
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/mi)?.[1];
  assert.ok(policy, 'static assets must have a content security policy');
  const directives = Object.fromEntries(policy.split(';').map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
  const workspaceStyles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="(https:\/\/da\.live\/[^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(workspaceStyles, [
    'https://da.live/nx2/styles/styles.css',
    'https://da.live/nx2/styles/buttons.css',
    'https://da.live/nx2/styles/form.css',
  ]);
  assert.deepEqual(directives['style-src'], ["'self'", 'https://da.live']);
  assert.deepEqual(directives['font-src'], ["'self'", 'https://da.live']);
  assert.deepEqual(directives['script-src'], ["'self'", 'https://da.live']);
  assert.deepEqual(directives['frame-ancestors'], ['https://da.live', 'https://*.da.live']);
});
