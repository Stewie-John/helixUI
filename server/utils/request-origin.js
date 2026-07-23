function splitOrigins(value = '') {
  return String(value).split(',').map((origin) => origin.trim()).filter(Boolean);
}

function normalizeHostname(value = '') {
  const candidate = String(value).trim().toLowerCase();
  if (!candidate) return '';

  try {
    const parsed = new URL(candidate.includes('://') ? candidate : `http://${candidate}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getRequestHost(request) {
  return String(request.headers?.host || '').trim();
}

function isAllowedRequestHost(request, allowedHosts = '') {
  const configuredHosts = splitOrigins(allowedHosts)
    .map(normalizeHostname)
    .filter(Boolean);
  if (configuredHosts.length === 0) return true;

  const requestHostname = normalizeHostname(getRequestHost(request));
  return Boolean(requestHostname && configuredHosts.includes(requestHostname));
}

function isAllowedWebSocketOrigin(request, options = {}) {
  const origin = String(request.headers?.origin || '').trim();
  if (!origin || origin === 'null') return Boolean(options.allowMissingOrigin);

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const configuredOrigins = new Set([
    ...splitOrigins(options.allowedOrigins),
    ...splitOrigins(options.corsOrigins),
  ]);
  if (configuredOrigins.has(parsed.origin)) return true;

  const requestHost = getRequestHost(request);
  return Boolean(requestHost && parsed.host === requestHost);
}

export {
  getRequestHost,
  isAllowedRequestHost,
  isAllowedWebSocketOrigin,
  normalizeHostname,
  splitOrigins,
};
