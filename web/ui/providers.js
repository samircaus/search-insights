/** Provider tabs. A provider is only shown when the site configuration enables it. */
export const PROVIDERS = [
  { id: 'google', label: 'Google', long: 'Google Search Console' },
  { id: 'bing', label: 'Bing', long: 'Bing Webmaster Tools' },
];

/** Providers enabled for this site (`status` is the backend's providerStatus()). */
export function visibleProviders(status) {
  return PROVIDERS.filter((p) => status?.[p.id]?.enabled === true);
}

/** Keep the current tab if it is still visible, otherwise the first visible one, or null. */
export function pickActive(current, status) {
  const visible = visibleProviders(status);
  if (visible.some((p) => p.id === current)) return current;
  return visible[0]?.id ?? null;
}
