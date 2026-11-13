import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceKeepingFocus } from '../web/ui/dom.js';

test('rerendering restores focus only to a replacement inside the same container', () => {
  const previousDocument = globalThis.document;
  const oldTab = { id: 'tab-google' };
  let focused = false;
  const newTab = { id: 'tab-google', focus: () => { focused = true; } };
  const otherControl = { id: 'elsewhere' };
  let children = [oldTab];
  const container = {
    contains: (element) => children.includes(element),
    replaceChildren: (...next) => { children = next; },
  };
  globalThis.document = {
    activeElement: oldTab,
    getElementById: (id) => [newTab, otherControl].find((element) => element.id === id),
  };
  try {
    replaceKeepingFocus(container, newTab);
    assert.equal(focused, true);

    focused = false;
    globalThis.document.activeElement = otherControl;
    replaceKeepingFocus(container, newTab);
    assert.equal(focused, false, 'focus outside the container must not be stolen');

    globalThis.document.activeElement = newTab;
    replaceKeepingFocus(container, otherControl);
    assert.equal(focused, false, 'a removed item must not receive focus outside the container');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
