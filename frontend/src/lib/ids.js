// Ids and hashes that also work on plain HTTP (crypto.randomUUID / crypto.subtle need HTTPS).
export function randomId(bytes = 12) {
  const a = new Uint8Array(bytes);
  (window.crypto || window.msCrypto).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashFile(file) {
  const buf = await file.arrayBuffer();
  if (window.crypto?.subtle) {
    const digest = await window.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback (insecure context): FNV-1a 32 bits, enough to identify the photo in the demo.
  let h = 0x811c9dc5;
  for (const byte of new Uint8Array(buf)) { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; }
  return `fnv-${h.toString(16)}`;
}
