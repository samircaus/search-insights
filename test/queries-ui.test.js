import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryWindow } from '../web/ui/queries.js';

function queryState(count = 58) {
  const queries = Array.from({ length: count }, (_, i) => ({
    query: `query ${String(i).padStart(2, '0')}`,
    current: { clicks: count - i, impressions: 100, ctr: 0.02, position: 10 },
    previous: { clicks: count - i + 1 },
    previousStatus: 'present',
  }));
  return {
    result: { queries, summary: { current: { ctr: 0.04 } } },
    search: '', filter: 'all', sort: { key: 'clicks', dir: 'desc' },
    selectedQueries: new Set(), queryLimit: 10,
  };
}

test('long query lists reveal ten rows at a time without dropping the remaining rows', () => {
  const state = queryState();
  let view = queryWindow(state);
  assert.equal(view.rows.length, 10);
  assert.equal(view.total, 58);
  assert.equal(view.hasMore, true);

  state.queryLimit += 10;
  view = queryWindow(state);
  assert.equal(view.rows.length, 20);
  assert.equal(view.rows[19].query, 'query 19');

  state.queryLimit = 60;
  view = queryWindow(state);
  assert.equal(view.rows.length, 58);
  assert.equal(view.rows[57].query, 'query 57');
  assert.equal(view.hasMore, false);
});

test('searching and sorting operate on all returned queries, not just visible rows', () => {
  const state = queryState();
  state.search = 'QUERY 57';
  let view = queryWindow(state);
  assert.deepEqual(view.rows.map((r) => r.query), ['query 57']);
  assert.equal(view.total, 1);
  assert.equal(view.hasMore, false);

  state.search = '';
  state.sort = { key: 'query', dir: 'desc' };
  view = queryWindow(state);
  assert.equal(view.rows[0].query, 'query 57');
  assert.equal(view.rows.length, 10);
});

test('click sorting breaks ties by impressions, including when every query has zero clicks', () => {
  const state = queryState(4);
  state.result.queries.forEach((row, i) => {
    row.current.clicks = 0;
    row.current.impressions = [10, 200, null, 50][i];
  });
  assert.deepEqual(queryWindow(state).rows.map((r) => r.query),
    ['query 01', 'query 03', 'query 00', 'query 02']);

  state.result.queries[0].current.clicks = 1;
  assert.deepEqual(queryWindow(state).rows.map((r) => r.query),
    ['query 00', 'query 01', 'query 03', 'query 02']);
  state.sort.dir = 'asc';
  assert.deepEqual(queryWindow(state).rows.map((r) => r.query),
    ['query 01', 'query 03', 'query 02', 'query 00']);
});

test('selected queries remain available across expanded and filtered views', () => {
  const state = queryState();
  state.selectedQueries.add('query 00');
  state.queryLimit = 60;
  state.selectedQueries.add('query 57');
  state.search = 'query 57';
  assert.deepEqual(queryWindow(state).rows.map((r) => r.query), ['query 57']);

  state.search = '';
  state.filter = 'selected';
  state.queryLimit = 10;
  assert.deepEqual(queryWindow(state).rows.map((r) => r.query), ['query 00', 'query 57']);
  assert.equal(state.selectedQueries.size, 2);
});

test('short and empty query lists have no additional rows to reveal', () => {
  const short = queryWindow(queryState(10));
  assert.equal(short.rows.length, 10);
  assert.equal(short.hasMore, false);
  const empty = queryWindow(queryState(0));
  assert.equal(empty.total, 0);
  assert.equal(empty.hasMore, false);
});
