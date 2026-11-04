// Public results stream over SSE, read with fetch() so we control reconnection completely:
//  - resumes with lastEventId (RF-6): the server answers with "catchup" or "snapshot"
//  - honours 503 + Retry-After and reconnects with full jitter (RF-10)
//  - a new subscription starts empty (snapshot); reconnections of the same subscription resume
import { API_URL } from './config.js';
import { retryDelay } from './backoff.js';

export function subscribePublic(topic, { onEvent, onState }) {
  let lastId = '';
  let attempt = 0;
  let stopped = false;
  let controller = null;
  let timer = null;

  const schedule = (retryAfterSec) => {
    if (stopped) return;
    const wait = retryDelay(attempt++, retryAfterSec);
    onState?.({ state: 'waiting', seconds: Math.round(wait / 1000) });
    timer = setTimeout(connect, wait);
  };

  async function connect() {
    if (stopped) return;
    controller = new AbortController();
    onState?.({ state: 'connecting' });
    const url = `${API_URL}/api/public/stream?topic=${encodeURIComponent(topic)}${lastId ? `&lastEventId=${encodeURIComponent(lastId)}` : ''}`;
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' }, cache: 'no-store' });
      if (res.status !== 200) {
        const body = await res.json().catch(() => ({}));
        onState?.({ state: res.status === 503 ? 'busy' : 'error', message: body.message });
        return schedule(Number(res.headers.get('Retry-After')) || 0);
      }
      attempt = 0;
      onState?.({ state: 'open' });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message', id = null, data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          if (id) lastId = id;
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          onEvent(event, parsed, id);
        }
      }
      onState?.({ state: 'closed' });
      schedule();
    } catch (err) {
      if (stopped) return;
      onState?.({ state: 'closed' });
      schedule();
    }
  }

  const onOnline = () => { if (!stopped) { clearTimeout(timer); attempt = 0; controller?.abort(); connect(); } };
  window.addEventListener('online', onOnline);
  connect();

  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    window.removeEventListener('online', onOnline);
  };
}
