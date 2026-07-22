/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
const requestedPlatformMode = process.env.VITE_IS_PLATFORM === 'true';

if (requestedPlatformMode && process.env.TRUST_PROXY_AUTH !== 'true') {
  throw new Error(
    'VITE_IS_PLATFORM=true bypasses built-in authentication. ' +
    'Set TRUST_PROXY_AUTH=true only when a trusted reverse proxy provides authentication.'
  );
}

export const IS_PLATFORM = requestedPlatformMode;
