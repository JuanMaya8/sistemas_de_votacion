import { API_URL } from './config.js';

export async function getJson(path) {
  const res = await fetch(`${API_URL}${path}`, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `Error ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { ...body, _instance: res.headers.get('X-Instance-Id') };
}

export async function postJson(path, data) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
