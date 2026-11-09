/**
 * Resolve a Workspace document to the public URL that search providers report on.
 *
 * Inputs are the verified Workspace context (`{ org, site, path }`, where path
 * is the document path such as "/martech/fpid" or "/de/index") and the site's
 * configuration. The production origin always comes from configuration; it is
 * never inferred from where the plugin is hosted.
 *
 * Result:
 *   { status: 'resolved', url, path, notes[] }
 *   { status: 'excluded', reason, path }          -> not a public page
 *   { status: 'needs-confirmation', url, reason } -> author must confirm
 */

const DEFAULT_PATHS = {
  indexName: 'index',
  stripExtensions: ['.html', '.htm'],
  excludedPrefixes: ['/drafts/', '/tools/', '/library/', '/fragments/', '/.da/'],
  excludedPaths: ['/nav', '/footer', '/metadata', '/placeholders', '/redirects', '/query-index'],
  mappings: [],
  trailingSlash: 'folders-only',
};

export function pathRules(siteConfig) {
  return { ...DEFAULT_PATHS, ...(siteConfig?.paths || {}) };
}

export function normalizeOrigin(origin) {
  const u = new URL(origin);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') {
    throw new Error('productionOrigin must be https');
  }
  return u.origin;
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Encode each path segment exactly once (decoding first, so input may be raw or encoded). */
export function encodePath(path) {
  return path.split('/').map((seg) => encodeURIComponent(safeDecode(seg))
    // Keep characters that are valid in paths and commonly unencoded.
    .replace(/%40/g, '@').replace(/%2C/gi, ',').replace(/%3A/gi, ':'))
    .join('/');
}

function stripExtension(path, exts) {
  for (const ext of exts) {
    if (path.toLowerCase().endsWith(ext)) return { path: path.slice(0, -ext.length), stripped: ext };
  }
  return { path, stripped: null };
}

function applyMappings(path, mappings) {
  for (const m of mappings || []) {
    if (m && typeof m.from === 'string' && typeof m.to === 'string' && path.startsWith(m.from)) {
      return { path: m.to + path.slice(m.from.length), mapping: m };
    }
  }
  return { path, mapping: null };
}

/**
 * Convert a document path into a public path, applying index, extension,
 * exclusion and mapping rules.
 */
export function documentPathToPublicPath(docPath, siteConfig) {
  const rules = pathRules(siteConfig);
  const notes = [];
  if (typeof docPath !== 'string' || !docPath.trim()) {
    return { status: 'needs-confirmation', reason: 'no-document-path' };
  }
  let path = docPath.trim();
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  // Workspace context paths never carry query/hash; strip defensively.
  path = path.split(/[?#]/)[0];

  const ext = stripExtension(path, rules.stripExtensions);
  path = ext.path;
  if (ext.stripped) notes.push(`Removed "${ext.stripped}" extension.`);

  // Any other extension (sheets, media, json) is not an HTML page.
  const last = path.split('/').pop();
  if (/\.[a-z0-9]{2,5}$/i.test(last)) {
    return { status: 'excluded', reason: 'not-a-page', path };
  }

  const lowerPath = path.toLowerCase();
  if ((rules.excludedPrefixes || []).some((p) => lowerPath.startsWith(p.toLowerCase()))) {
    return { status: 'excluded', reason: 'not-public', path };
  }
  if ((rules.excludedPaths || []).some((p) => lowerPath === p.toLowerCase())) {
    return { status: 'excluded', reason: 'not-public', path };
  }

  // Index documents are served at the folder URL.
  const segments = path.split('/');
  if (segments[segments.length - 1] === rules.indexName) {
    segments[segments.length - 1] = '';
    path = segments.join('/') || '/';
    notes.push('Index document maps to its folder URL.');
  } else if (path.endsWith('/') && path !== '/') {
    // A folder path without a document: treat as its index page.
    notes.push('Folder path treated as its index page.');
  }

  if (rules.trailingSlash === 'never' && path !== '/' && path.endsWith('/')) {
    path = path.slice(0, -1);
  } else if (rules.trailingSlash === 'always' && !path.endsWith('/')) {
    path = `${path}/`;
  }

  const mapped = applyMappings(path, rules.mappings);
  if (mapped.mapping) {
    path = mapped.path;
    notes.push(`Mapped "${mapped.mapping.from}" to "${mapped.mapping.to}".`);
  }

  if (path !== path.toLowerCase()) {
    notes.push('Path contains uppercase characters; Edge Delivery URLs are usually lowercase. Please confirm.');
    return { status: 'needs-confirmation', reason: 'uppercase-path', path: encodePath(path), notes };
  }

  return { status: 'resolved', path: encodePath(path), notes };
}

/**
 * Resolve the public URL for the current Workspace document.
 * @param {{org?:string, site?:string, repo?:string, path?:string}} context
 */
export function resolvePublicUrl(context, siteConfig) {
  if (!siteConfig?.productionOrigin) {
    return { status: 'needs-confirmation', reason: 'no-production-origin' };
  }
  const origin = normalizeOrigin(siteConfig.productionOrigin);
  const org = context?.org;
  const site = context?.site || context?.repo;
  if (siteConfig.da && (org !== siteConfig.da.org || site !== siteConfig.da.site)) {
    return { status: 'needs-confirmation', reason: 'site-mismatch' };
  }
  const res = documentPathToPublicPath(context?.path, siteConfig);
  if (res.status === 'excluded') return res;
  if (!res.path) return res;
  return { ...res, url: origin + res.path };
}

/** Recognise preview/live branch hosts: {branch}--{site}--{org}.aem.(page|live) */
export function parseAemHost(hostname) {
  const m = /^([a-z0-9-]+?)--([a-z0-9-]+?)--([a-z0-9-]+)\.(aem|hlx)\.(page|live)$/i.exec(hostname);
  if (!m) return null;
  return { branch: m[1], site: m[2], org: m[3], tier: m[5] };
}

/**
 * Validate an author-entered URL override. Only URLs on the configured
 * production origin are accepted. Preview/branch URLs of the configured
 * DA site are mapped to the production origin. Bare paths are allowed.
 */
export function validateOverride(input, siteConfig) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'empty' };
  const origin = normalizeOrigin(siteConfig.productionOrigin);
  let raw = input.trim();
  if (raw.startsWith('/')) raw = origin + raw;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (u.username || u.password) return { ok: false, reason: 'credentials-not-allowed' };
  const notes = [];
  const aem = parseAemHost(u.hostname);
  if (aem) {
    const da = siteConfig.da || {};
    if (aem.org.toLowerCase() === String(da.org).toLowerCase()
      && aem.site.toLowerCase() === String(da.site).toLowerCase()) {
      notes.push(`Mapped ${aem.tier === 'page' ? 'preview' : 'live'} host to the production origin.`);
      u = new URL(u.pathname + u.search, origin);
    } else {
      return { ok: false, reason: 'other-site' };
    }
  }
  if (u.origin !== origin) return { ok: false, reason: 'origin-not-allowed' };
  if (u.search) notes.push('Query string removed; search providers report the page URL.');
  const path = encodePath(u.pathname);
  return { ok: true, url: origin + path, path, notes };
}

/**
 * Is `url` covered by a Search Console property?
 *  - "sc-domain:example.com" covers example.com and all subdomains, any protocol.
 *  - URL-prefix properties ("https://example.com/") cover URLs starting with the prefix.
 */
export function isUrlInGoogleProperty(url, property) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (typeof property !== 'string') return false;
  if (property.startsWith('sc-domain:')) {
    const domain = property.slice('sc-domain:'.length).toLowerCase();
    const host = u.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  return url.startsWith(property);
}

/** Bing site URLs are site roots like "https://example.com/". Compare by origin. */
export function isUrlInBingSite(url, siteUrl) {
  try {
    return new URL(url).origin === new URL(siteUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Decide what to do with a canonical URL read from the published page.
 * Only canonical URLs on the production origin are considered.
 */
export function compareCanonical(resolvedUrl, canonicalHref, siteConfig) {
  if (!canonicalHref) return { status: 'none' };
  let canonical;
  try {
    canonical = new URL(canonicalHref, resolvedUrl);
  } catch {
    return { status: 'invalid' };
  }
  const origin = normalizeOrigin(siteConfig.productionOrigin);
  if (canonical.origin !== origin) {
    return { status: 'other-origin', canonical: canonical.href };
  }
  const normalized = origin + encodePath(canonical.pathname);
  if (normalized === resolvedUrl) return { status: 'match', canonical: normalized };
  return { status: 'differs', canonical: normalized };
}
