const status = document.getElementById('status');
const button = document.getElementById('clear-cache-button');

function appendStatus(message, className = '') {
  const line = document.createElement('p');
  line.textContent = message;
  if (className) line.className = className;
  status.appendChild(line);
}

button?.addEventListener('click', async () => {
  button.disabled = true;
  status.replaceChildren();
  appendStatus('Clearing cache and service workers...');

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
        appendStatus('Unregistered service worker', 'success');
      }
    }

    if ('caches' in window) {
      const cacheNames = await caches.keys();
      for (const cacheName of cacheNames) {
        await caches.delete(cacheName);
        appendStatus(`Deleted cache: ${cacheName}`, 'success');
      }
    }

    localStorage.clear();
    sessionStorage.clear();
    appendStatus('Cleared browser storage', 'success');
    appendStatus('All caches cleared.', 'success');

    const homeLink = document.createElement('a');
    homeLink.href = '/';
    homeLink.textContent = 'Go to home page';
    status.appendChild(homeLink);
  } catch (error) {
    appendStatus(`Error: ${error instanceof Error ? error.message : String(error)}`, 'error');
    button.disabled = false;
  }
});
