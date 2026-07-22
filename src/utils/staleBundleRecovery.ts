const RECOVERY_KEY = 'ccui-stale-bundle-recovery';
const RECOVERY_QUERY = '__ccui_recover';
const RECOVERY_WINDOW_MS = 5 * 60 * 1000;

const getLoadedEntryAsset = () => {
  const scripts = Array.from(document.scripts);
  return scripts
    .map((script) => script.src)
    .find((src) => /\/assets\/index-[^/]+\.js(?:\?|$)/.test(src)) || 'unknown-entry';
};

export const scheduleStaleBundleRecovery = (error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error || '');
  const recoverable =
    /Cannot access ['"].+['"] before initialization/i.test(message) ||
    /ChunkLoadError|Loading chunk|dynamically imported module/i.test(message);
  if (!recoverable) return false;

  const marker = `${getLoadedEntryAsset()}|${message}`;
  try {
    const previous = JSON.parse(sessionStorage.getItem(RECOVERY_KEY) || 'null');
    if (previous?.marker === marker && Date.now() - Number(previous?.at || 0) < RECOVERY_WINDOW_MS) {
      return false;
    }
    sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ marker, at: Date.now() }));
  } catch {
    // Recovery still works when sessionStorage is unavailable.
  }

  window.setTimeout(() => {
    const url = new URL(window.location.href);
    url.searchParams.set(RECOVERY_QUERY, String(Date.now()));
    window.location.replace(url.toString());
  }, 0);
  return true;
};

export const removeStaleBundleRecoveryQuery = () => {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(RECOVERY_QUERY)) return;
  url.searchParams.delete(RECOVERY_QUERY);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
};
