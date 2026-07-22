import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import 'katex/dist/katex.min.css'
import { removeStaleBundleRecoveryQuery } from './utils/staleBundleRecovery'

// Initialize i18n
import './i18n/config.js'

removeStaleBundleRecoveryQuery()

// The HTTP-to-HTTPS handoff carries only the existing login token in a URL
// fragment. Consume and erase it before AuthContext reads localStorage.
if (window.location.hash.startsWith('#ccui-auth=')) {
  const token = decodeURIComponent(window.location.hash.slice('#ccui-auth='.length));
  if (token) localStorage.setItem('auth-token', token);
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

// Clean up stale service workers on app load to prevent caching issues after builds
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => {
      registration.unregister();
    });
  }).catch(err => {
    console.warn('Failed to unregister service workers:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
