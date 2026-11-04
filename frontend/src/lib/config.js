// Backend location. Empty VITE_API_URL = same origin (served by Caddy next to the API).
const env = import.meta.env || {};

export const API_URL = (env.VITE_API_URL || '').replace(/\/$/, '');

export const WS_URL = API_URL
  ? API_URL.replace(/^http/, 'ws')
  : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
