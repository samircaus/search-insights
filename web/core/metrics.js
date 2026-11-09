/**
 * Metric helpers shared by the backend normalizers and the browser UI.
 *
 * Conventions (see docs/metrics.md):
 * - CTR = clicks / impressions. Zero impressions -> null (undefined CTR), never 0.
 * - CTR changes are expressed in percentage points (pp).
 * - Relative change from a zero baseline is "new", never +Infinity%.
 * - `null` means "missing / unknown" and is distinct from 0.
 * - Lower average position is better.
 */

export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function ctr(clicks, impressions) {
  if (!isNum(clicks) || !isNum(impressions) || impressions <= 0) return null;
  return clicks / impressions;
}

/**
 * Relative change between two counts.
 * @returns {{kind:'change', value:number}|{kind:'new'}|{kind:'unchanged-zero'}|{kind:'not-comparable'}}
 */
export function relativeChange(current, previous) {
  if (!isNum(current) || !isNum(previous)) return { kind: 'not-comparable' };
  if (previous === 0) {
    if (current === 0) return { kind: 'unchanged-zero' };
    return { kind: 'new' };
  }
  return { kind: 'change', value: (current - previous) / previous };
}

/** Difference of two ratios (0..1) expressed in percentage points. */
export function ppChange(currentRatio, previousRatio) {
  if (!isNum(currentRatio) || !isNum(previousRatio)) return null;
  return (currentRatio - previousRatio) * 100;
}

/**
 * Position change. Positive `delta` means the position number increased (worse).
 * @returns {{delta:number, direction:'improved'|'declined'|'unchanged'}|null}
 */
export function positionChange(current, previous, epsilon = 0.05) {
  if (!isNum(current) || !isNum(previous)) return null;
  const delta = current - previous;
  let direction = 'unchanged';
  if (delta < -epsilon) direction = 'improved';
  else if (delta > epsilon) direction = 'declined';
  return { delta, direction };
}

/**
 * Impression-weighted average position across rows.
 * Never averages averages without weights; rows without impressions are skipped.
 */
export function weightedPosition(rows, key = 'position') {
  let weight = 0;
  let sum = 0;
  for (const r of rows) {
    if (isNum(r?.[key]) && isNum(r?.impressions) && r.impressions > 0) {
      sum += r[key] * r.impressions;
      weight += r.impressions;
    }
  }
  return weight > 0 ? sum / weight : null;
}

export function metricSet({ clicks = null, impressions = null, position = null } = {}) {
  return {
    clicks: isNum(clicks) ? clicks : null,
    impressions: isNum(impressions) ? impressions : null,
    ctr: ctr(clicks, impressions),
    position: isNum(position) ? position : null,
  };
}

/** All changes for a pair of metric sets. `previous` may be null (no valid comparison). */
export function compareMetricSets(current, previous) {
  if (!previous) {
    return {
      clicks: { kind: 'not-comparable' },
      impressions: { kind: 'not-comparable' },
      ctrPp: null,
      position: null,
    };
  }
  return {
    clicks: relativeChange(current.clicks, previous.clicks),
    clicksAbs: isNum(current.clicks) && isNum(previous.clicks) ? current.clicks - previous.clicks : null,
    impressions: relativeChange(current.impressions, previous.impressions),
    impressionsAbs: isNum(current.impressions) && isNum(previous.impressions)
      ? current.impressions - previous.impressions : null,
    ctrPp: ppChange(current.ctr, previous.ctr),
    position: positionChange(current.position, previous.position),
  };
}

/**
 * Join current and previous query rows.
 *
 * A query absent from the previous *returned* rows is NOT a confirmed zero:
 * providers return top rows only. `previousStatus` records why there is no value.
 *
 * @param {Array<{query:string,clicks:number,impressions:number,position:number|null}>} currentRows
 * @param {Array|null} previousRows null when no comparable previous period exists
 */
export function joinQueryRows(currentRows, previousRows) {
  const prevMap = new Map();
  if (Array.isArray(previousRows)) {
    for (const r of previousRows) prevMap.set(r.query, r);
  }
  const out = currentRows.map((r) => {
    const current = metricSet(r);
    let previous = null;
    let previousStatus = 'not-comparable';
    if (Array.isArray(previousRows)) {
      const p = prevMap.get(r.query);
      if (p) {
        previous = metricSet(p);
        previousStatus = 'present';
      } else {
        previousStatus = 'not-in-returned-rows';
      }
    }
    return {
      query: r.query,
      current,
      previous,
      previousStatus,
      change: compareMetricSets(current, previous),
    };
  });
  // Queries present before but not in the current returned rows.
  const currentSet = new Set(currentRows.map((r) => r.query));
  const disappeared = Array.isArray(previousRows)
    ? previousRows.filter((r) => !currentSet.has(r.query)).map((r) => ({
      query: r.query,
      current: null,
      currentStatus: 'not-in-returned-rows',
      previous: metricSet(r),
    }))
    : [];
  return { rows: out, onlyInPrevious: disappeared };
}

// ---------------------------------------------------------------------------
// Formatting (UI + brief). Keep units explicit; never rely on colour alone.
// ---------------------------------------------------------------------------

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtInt(v) {
  return isNum(v) ? intFmt.format(v) : '—';
}

export function fmtPct(ratio, digits = 1) {
  return isNum(ratio) ? `${(ratio * 100).toFixed(digits)}%` : '—';
}

export function fmtPos(v) {
  return isNum(v) ? v.toFixed(1) : '—';
}

export function fmtRelChange(change) {
  if (!change) return 'not comparable';
  switch (change.kind) {
    case 'change': {
      const pct = change.value * 100;
      const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
      return `${sign}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
    }
    case 'new': return 'new (was 0)';
    case 'unchanged-zero': return 'no change (0)';
    default: return 'not comparable';
  }
}

export function fmtPp(pp) {
  if (!isNum(pp)) return 'not comparable';
  const sign = pp > 0 ? '+' : pp < 0 ? '−' : '±';
  return `${sign}${Math.abs(pp).toFixed(1)} pp`;
}

export function fmtPosChange(pc) {
  if (!pc) return 'not comparable';
  const abs = Math.abs(pc.delta).toFixed(1);
  if (pc.direction === 'improved') return `improved by ${abs}; lower is better`;
  if (pc.direction === 'declined') return `worsened by ${abs}; lower is better`;
  return 'unchanged';
}

/** Direction word for a relative change, used for text labels (not colour). */
export function changeDirection(change) {
  if (!change) return 'unknown';
  if (change.kind === 'new') return 'up';
  if (change.kind !== 'change') return 'flat';
  if (change.value > 0.005) return 'up';
  if (change.value < -0.005) return 'down';
  return 'flat';
}
