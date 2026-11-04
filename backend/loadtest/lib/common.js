// Shared helpers for the load tests (no external dependencies).
import http from 'node:http';
import https from 'node:https';

export function args(defaults) {
  const out = { ...defaults };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    const val = next === undefined || next.startsWith('--') ? true : (i++, next);
    out[key] = typeof defaults[key] === 'number' ? Number(val) : val;
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const lib = (url) => (url.startsWith('https') ? https : http);

/** Exponential backoff with FULL jitter: random(0, min(cap, base * 2^attempt)). */
export const fullJitter = (attempt, base = 3000, cap = 30000) => Math.random() * Math.min(cap, base * 2 ** attempt);

export async function json(url, method = 'GET', body, agent) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = lib(url).request(u, { method, agent, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }); } catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Minimal SSE client. Calls onEvent({event, id, data}) for every event.
 * opts.lastEventId resumes; opts.onOpen(res); returns { req, close() }.
 */
export function openSse(base, topic, { lastEventId, onEvent, onOpen, onClose, onError }) {
  const u = new URL(`${base}/api/public/stream`);
  u.searchParams.set('topic', topic);
  if (lastEventId) u.searchParams.set('lastEventId', lastEventId);
  const req = lib(base).get(u, { agent: false, headers: { Accept: 'text/event-stream' } }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      onError?.({ status: res.statusCode, retryAfter: Number(res.headers['retry-after'] || 0) });
      return;
    }
    onOpen?.(res);
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = { event: 'message', id: null, data: '' };
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = line.slice(4);
          else if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) ev.data += line.slice(6);
        }
        if (ev.data || ev.id) onEvent?.(ev, chunk.length);
      }
    });
    res.on('close', () => onClose?.());
  });
  req.on('error', (e) => onError?.({ status: 0, error: e.message }));
  return { req, close: () => req.destroy() };
}

/** Writes a simple SVG line chart: series = [{ name, color, points: [y0, y1, ...] }] (x = seconds). */
export function svgChart(title, series, yLabel = '') {
  const W = 900, H = 420, L = 70, R = 20, T = 50, B = 50;
  const maxX = Math.max(...series.map((s) => s.points.length)) - 1 || 1;
  const maxY = Math.max(1, ...series.flatMap((s) => s.points));
  const x = (i) => L + (i / maxX) * (W - L - R);
  const y = (v) => H - B - (v / maxY) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxY * f));
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif" font-size="12">`;
  svg += `<rect width="100%" height="100%" fill="#fff"/><text x="${L}" y="28" font-size="16" font-weight="bold">${title}</text>`;
  for (const t of ticks) svg += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#e5e5e5"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" fill="#555">${t}</text>`;
  svg += `<text x="${W / 2}" y="${H - 12}" text-anchor="middle" fill="#555">segundos</text><text x="18" y="${H / 2}" transform="rotate(-90 18 ${H / 2})" text-anchor="middle" fill="#555">${yLabel}</text>`;
  series.forEach((s, k) => {
    svg += `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`;
    svg += `<rect x="${W - R - 220}" y="${T + k * 20}" width="12" height="12" fill="${s.color}"/><text x="${W - R - 202}" y="${T + 10 + k * 20}">${s.name}</text>`;
  });
  return svg + '</svg>';
}
