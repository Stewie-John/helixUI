function splitOrigins(value = '') {
  return String(value).split(',').map((origin) => origin.trim()).filter(Boolean);
}

function getRequestHost(request) {
  const forwardedHost = String(request.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  return forwardedHost || String(request.headers?.host || '').trim();
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

export { getRequestHost, isAllowedWebSocketOrigin, splitOrigins };
