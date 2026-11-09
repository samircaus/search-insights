/**
 * Deployment configuration.
 *
 * Non-secret site configuration comes from the `SITES` variable (a JSON
 * object or string, see wrangler.example.jsonc). Secrets come only from the
 * platform secret store (env): GOOGLE_CLIENT_SECRET, BING_API_KEY,
 * BING_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY.
 */
import { normalizeOrigin } from '../web/core/url-resolver.js';
import { mergeThresholds } from '../web/core/opportunities.js';
import { AppError } from './errors.js';

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export function validateSite(site) {
  const errors = [];
  if (!site || typeof site !== 'object') return ['site must be an object'];
  if (!ID.test(site.id || '')) errors.push('id is required (letters, digits, dashes)');
  if (!site.da?.org || !site.da?.site) errors.push('da.org and da.site are required');
  try {
    normalizeOrigin(site.productionOrigin);
  } catch {
    errors.push('productionOrigin must be an https origin');
  }
  if (site.google) {
    const props = site.google.properties;
    if (!Array.isArray(props) || !props.length) errors.push('google.properties must list at least one property');
    else {
      props.forEach((p) => {
        if (!(typeof p === 'string' && (p.startsWith('sc-domain:') || /^https?:\/\/.+\/$/.test(p)))) {
          errors.push(`google.properties: "${p}" must be "sc-domain:example.com" or a URL prefix ending in "/"`);
        }
      });
    }
  }
  if (site.bing) {
    if (!/^https?:\/\/[^/]+\/?$/.test(site.bing.siteUrl || '')) errors.push('bing.siteUrl must be a site root URL');
    if (!['apiKey', 'oauth'].includes(site.bing.auth)) errors.push('bing.auth must be "apiKey" or "oauth"');
  }
  if (site.access?.allowedUserIds && !Array.isArray(site.access.allowedUserIds)) {
    errors.push('access.allowedUserIds must be an array');
  }
  return errors;
}

export function loadSites(env) {
  let raw = env.SITES;
  if (typeof raw === 'string') raw = JSON.parse(raw);
  const sites = Array.isArray(raw) ? raw : raw?.sites;
  if (!Array.isArray(sites)) throw new Error('SITES configuration is missing');
  sites.forEach((s) => {
    const errs = validateSite(s);
    if (errs.length) throw new Error(`Invalid site "${s?.id}": ${errs.join('; ')}`);
  });
  return sites;
}

export function findSite(sites, org, site) {
  if (typeof org !== 'string' || typeof site !== 'string') return null;
  return sites.find((s) => s.da.org.toLowerCase() === org.toLowerCase()
    && s.da.site.toLowerCase() === site.toLowerCase()) || null;
}

export function requireSite(sites, org, site) {
  const s = findSite(sites, org, site);
  if (!s) throw new AppError('FORBIDDEN_SITE', 'site not configured');
  return s;
}

/** Provider availability for this deployment (no secret values). */
export function providerStatus(site, env) {
  return {
    google: {
      enabled: !!site.google,
      configured: !!(site.google && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      auth: 'oauth',
    },
    bing: {
      enabled: !!site.bing,
      configured: !!(site.bing && (site.bing.auth === 'apiKey'
        ? env.BING_API_KEY
        : env.BING_CLIENT_ID && env.BING_CLIENT_SECRET)),
      auth: site.bing?.auth || null,
    },
  };
}

/** The subset of site configuration the browser may see. */
export function publicSiteConfig(site) {
  return {
    id: site.id,
    label: site.label || site.id,
    da: { org: site.da.org, site: site.da.site },
    productionOrigin: normalizeOrigin(site.productionOrigin),
    paths: site.paths || {},
    google: site.google ? { properties: site.google.properties } : null,
    bing: site.bing ? { siteUrl: site.bing.siteUrl } : null,
    thresholds: mergeThresholds(site.thresholds),
    reportingDays: site.reportingDays || 28,
  };
}
