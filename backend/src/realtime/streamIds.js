// Redis Stream ids are "<ms>-<seq>" and strictly increasing; they are our monotonic event ids.
export function compareIds(a, b) {
  if (a === b) return 0;
  const [am, as] = String(a || '0-0').split('-').map(Number);
  const [bm, bs] = String(b || '0-0').split('-').map(Number);
  if (am !== bm) return am < bm ? -1 : 1;
  return (as || 0) < (bs || 0) ? -1 : (as || 0) > (bs || 0) ? 1 : 0;
}

export const isStreamId = (s) => typeof s === 'string' && /^\d+-\d+$/.test(s);
