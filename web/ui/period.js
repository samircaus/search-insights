/** Reporting windows the Worker accepts; each is compared with the previous window of the same length. */
export const PERIOD_DAYS = [7, 28, 90];

export function periodDays(value, fallback = 28) {
  const n = Number(value);
  if (PERIOD_DAYS.includes(n)) return n;
  return PERIOD_DAYS.includes(Number(fallback)) ? Number(fallback) : 28;
}
