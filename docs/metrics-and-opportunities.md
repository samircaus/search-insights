# Metrics and opportunity rules

## Metric definitions

| Metric | Definition |
| --- | --- |
| Clicks, impressions | As reported by the provider for the page URL and period. |
| CTR | `clicks / impressions`. With zero impressions CTR is **undefined** (shown as —), not 0%. |
| CTR change | Difference in **percentage points** (pp), e.g. 2.9% → 2.4% = −0.6 pp. |
| Relative change | `(current − previous) / previous`. From a zero baseline it is shown as "new (was 0)". If either side is missing, it is "not comparable". |
| Average position | Lower is better. An increase is shown as "worse", a decrease as "improved", and the arrow is always paired with the word. Google: the page's average topmost position. Bing: `AvgImpressionPosition`. |
| Aggregated position | Only where we aggregate (Bing rows across weeks), and always **impression-weighted**. Averages are never averaged without weights. |
| Missing vs zero | `null` means missing. A query that is absent from the previous period's *returned rows* is labelled "prev —" (explained on hover and to screen readers), not 0, because providers return top rows only. |

**Page totals:**
- Google: always fetched separately with a page filter, never summed from query rows.
- Bing: taken from `GetPageStats` when the page is listed there; otherwise summed from query rows and labelled as such.

**Comparison windows:**
- Google: the latest finalized date for the property (property-wide `date` query, `dataState: final`) ends the current window. The previous window is the immediately preceding window of equal length, e.g. 28 vs 28 days, inclusive. Dates are Pacific Time calendar days. Arithmetic is on calendar dates, so DST cannot shift boundaries.
- Bing: windows are built from the dates Bing attaches to rows. A comparison is offered only if both windows contain the same number of row dates.

## Opportunity rules

All rules are deterministic. The thresholds below are defaults; override them per site with `thresholds` in `SITES`.

| Rule | Fires when | Card says | Never claims |
| --- | --- | --- | --- |
| **Low volume** (gate) | Page impressions < `minPageImpressions` (100) | No cards, with an explanation | — |
| **Declining clicks** | Valid comparison, previous clicks ≥ `decliningClicks.minPreviousClicks` (20), drop ≥ `minRelativeDrop` (20%) and ≥ `minAbsoluteDrop` (5) | Shows clicks, impressions, CTR (pp) and position changes, plus the queries with the largest click declines among rows returned in both periods. Suggests comparing these signals and checking for page changes and seasonality. | That the change has a known cause |
| **Low CTR** | Query impressions ≥ `lowCtr.minImpressions` (100), position ≤ `maxPosition` (10), CTR ≤ `maxRatioToPageCtr` (0.5) × page CTR | Review whether the title and description reflect the query intent, and check how the result appears first. | That the title is the cause |
| **Near first page** | Position between `nearFirstPage.minPosition` (8) and `maxPosition` (20), impressions ≥ `minImpressions` (30) | Read the page as that searcher: does it answer the need early? | That content is missing; that edits change rankings |
| **In this period's data** | Valid comparison, previous period returned rows and was **not** truncated, query not among previous returned rows, impressions ≥ `newlyVisible.minImpressions` (30) | Consider whether the query reflects a need worth addressing, and check existing coverage first. | That the query is new |

- **Card limits:** at most three cards per query rule. A query flagged by one rule is not repeated by another.
- **Brief wording:** because page content is not inspected, the brief lists *checks* and *questions*, not claims.
- **Caveats in the brief:** it always includes the providers' top-rows limitation, the coverage share, and a follow-up date one reporting period after the current end date.

## Example override

```json
"thresholds": {
  "minPageImpressions": 50,
  "lowCtr": { "minImpressions": 50 },
  "nearFirstPage": { "maxPosition": 15 }
}
```
