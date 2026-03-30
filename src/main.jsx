import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './scripture-forge.jsx';

// Polyfill window.storage for standalone deployment (maps to localStorage)
if (!window.storage) {
  const storageAdapter = {
    async get(key, shared) {
      try {
        const val = localStorage.getItem(shared ? `shared:${key}` : key);
        return val ? { key, value: val, shared: !!shared } : null;
      } catch { return null; }
    },
    async set(key, value, shared) {
      try {
        localStorage.setItem(shared ? `shared:${key}` : key, value);
        return { key, value, shared: !!shared };
      } catch { return null; }
    },
    async delete(key, shared) {
      try {
        localStorage.removeItem(shared ? `shared:${key}` : key);
        return { key, deleted: true, shared: !!shared };
      } catch { return null; }
    },
    async list(prefix, shared) {
      try {
        const keys = [];
        const pre = shared ? `shared:${prefix || ''}` : (prefix || '');
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith(pre)) keys.push(k.replace(/^shared:/, ''));
        }
        return { keys, prefix, shared: !!shared };
      } catch { return { keys: [], prefix, shared: !!shared }; }
    },
  };
  window.storage = storageAdapter;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
