import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceActions } from '../web/workspace.js';

test('Workspace prompts are drafted without automatically sending them', () => {
  const calls = [];
  const actions = createWorkspaceActions({
    setPrompt: (...args) => calls.push(args),
  });
  assert.equal(actions.canSetPrompt, true);
  actions.setPrompt('Selected search evidence');
  assert.deepEqual(calls, [['Selected search evidence', { autoSend: false }]]);
});

test('the adapter reports missing prompt support and propagates host errors', () => {
  assert.equal(createWorkspaceActions().canSetPrompt, false);
  const error = new Error('Disconnected');
  const actions = createWorkspaceActions({ setPrompt: () => { throw error; } });
  assert.throws(() => actions.setPrompt('Evidence'), error);
});
