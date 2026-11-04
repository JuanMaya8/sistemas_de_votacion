// INP (Interaction to Next Paint) measured in the real browser (RT-9), without libraries.
// Uses the Event Timing API: for every user interaction we keep its longest event duration; INP is
// the worst interaction (or the 98th percentile when there are 50+ interactions), as Web Vitals does.
import { API_URL } from './config.js';

const interactions = new Map(); // interactionId -> max duration
let listeners = [];
let lastReported = null;

export function currentInp() {
  const values = Array.from(interactions.values()).sort((a, b) => b - a);
  if (!values.length) return null;
  const idx = Math.min(values.length - 1, Math.floor(values.length / 50));
  return Math.round(values[idx]);
}

export const inpRating = (v) => (v == null ? '—' : v <= 200 ? 'bueno' : v <= 500 ? 'mejorable' : 'malo');

export function onInp(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

function report() {
  const v = currentInp();
  if (v == null || v === lastReported) return;
  lastReported = v;
  const body = JSON.stringify({ value: v, page: location.hash });
  try {
    // text/plain + keepalive: no CORS preflight and no cookies, works cross-origin and on page hide.
    fetch(`${API_URL}/api/metrics/inp`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(() => {});
  } catch { /* best effort */ }
}

let started = false;
export function startInpMonitor() {
  if (started || typeof PerformanceObserver === 'undefined') return;
  started = true;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.interactionId) continue;
        const prev = interactions.get(e.interactionId) || 0;
        if (e.duration > prev) interactions.set(e.interactionId, e.duration);
      }
      const v = currentInp();
      listeners.forEach((l) => l(v));
    });
    po.observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch { return; /* browser without Event Timing */ }
  setInterval(report, 15000);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') report(); });
}
