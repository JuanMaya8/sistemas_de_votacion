// Jurado outbox (RT-6): every acta is stored locally BEFORE trying to send it, and stays there
// until the server gives a FINAL answer. The idempotency key is created once and reused on every
// retry, so a resend can never be counted twice (RF-1).
const KEY = 'jurado:outbox:v1';

export function loadOutbox() {
  try {
    // An acta that was "sending" when the page closed has no known answer: resend it (same idem).
    return (JSON.parse(localStorage.getItem(KEY)) || []).map((i) => (i.state === 'sending' ? { ...i, state: 'retry', nextAttemptAt: 0 } : i));
  } catch { return []; }
}

export function saveOutbox(items) {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export function nextVersion(items, actaId) {
  const versions = items.filter((i) => i.acta.acta === actaId).map((i) => i.acta.version);
  return versions.length ? Math.max(...versions) + 1 : 1;
}
