import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { startInpMonitor } from './lib/inp.js';
import './styles.css';

startInpMonitor();
createRoot(document.getElementById('root')).render(<App />);

// Service worker: keeps the app shell available offline (the jurado can reopen the page without network).
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
