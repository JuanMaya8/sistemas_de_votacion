// WebSocket that never gives up: reconnects with full jitter, and supports request/response by
// requestId. Used by the jurado app and the verification consoles.
import { WS_URL } from './config.js';
import { fullJitter } from './backoff.js';
import { randomId } from './ids.js';

export class LiveSocket {
  constructor(path, { onOpen, onMessage, onState } = {}) {
    this.path = path;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onState = onState;
    this.attempt = 0;
    this.pending = new Map();
    this.stopped = false;
    this.ws = null;
    this.timer = null;
    this.handleOnline = () => { if (!this.isOpen()) this.reconnectNow(); };
    window.addEventListener('online', this.handleOnline);
    this.connect();
  }

  isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect() {
    if (this.stopped) return;
    this.onState?.('connecting');
    let ws;
    try { ws = new WebSocket(`${WS_URL}${this.path}`); } catch { return this.schedule(); }
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this.onState?.('open'); this.onOpen?.(); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.requestId && this.pending.has(msg.requestId)) {
        const p = this.pending.get(msg.requestId);
        this.pending.delete(msg.requestId);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
      this.onMessage?.(msg);
    };
    ws.onclose = (ev) => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('closed')); }
      this.pending.clear();
      this.onState?.(ev.code === 4008 ? 'slow' : 'closed');
      this.schedule();
    };
    ws.onerror = () => {};
  }

  schedule() {
    if (this.stopped || this.timer) return;
    const wait = fullJitter(this.attempt++);
    this.onState?.('waiting', Math.round(wait / 1000));
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, wait);
  }

  reconnectNow() {
    clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.connect();
  }

  send(obj) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  request(obj, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const requestId = randomId(6);
      if (!this.send({ ...obj, requestId })) return reject(new Error('offline'));
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('timeout')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    window.removeEventListener('online', this.handleOnline);
    this.ws?.close();
  }
}
