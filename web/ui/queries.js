import { isNum } from '../core/metrics.js';

export const QUERY_BATCH_SIZE = 10;

const SORTS = {
  query: (r) => r.query.toLowerCase(),
  clicks: (r) => r.current.clicks ?? -1,
  impressions: (r) => r.current.impressions ?? -1,
  ctr: (r) => r.current.ctr ?? -1,
  position: (r) => r.current.position ?? Infinity,
  delta: (r) => (r.previousStatus === 'present' ? r.current.clicks - r.previous.clicks : -Infinity),
};

/** Filter and sort all returned rows before limiting what is displayed. */
export function queryWindow(p) {
  const pageCtr = p.result.summary.current.ctr;
  const term = p.search.trim().toLowerCase();
  let rows = p.result.queries.filter((r) => !term || r.query.toLowerCase().includes(term));
  if (p.filter === 'near') rows = rows.filter((r) => isNum(r.current.position) && r.current.position >= 8 && r.current.position <= 20);
  if (p.filter === 'lowctr') rows = rows.filter((r) => isNum(r.current.ctr) && isNum(pageCtr) && r.current.ctr < pageCtr && r.current.impressions >= 20);
  if (p.filter === 'notprev') rows = rows.filter((r) => r.previousStatus === 'not-in-returned-rows');
  if (p.filter === 'selected') rows = rows.filter((r) => p.selectedQueries.has(r.query));
  const fn = SORTS[p.sort.key];
  const dir = p.sort.dir === 'asc' ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    const x = fn(a); const y = fn(b);
    const primary = x < y ? -dir : x > y ? dir : 0;
    if (primary || p.sort.key !== 'clicks') return primary;
    return SORTS.impressions(b) - SORTS.impressions(a);
  });
  return {
    rows: rows.slice(0, p.queryLimit),
    total: rows.length,
    hasMore: rows.length > p.queryLimit,
  };
}
