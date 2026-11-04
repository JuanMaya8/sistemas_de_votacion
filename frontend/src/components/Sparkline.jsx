import React from 'react';

/** Tiny SVG line chart: series = [{ name, color, values: number[] }] */
export default function Sparkline({ series, height = 90, unit = '' }) {
  const W = 320;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = Math.max(2, ...series.map((s) => s.values.length));
  const x = (i) => (i / (n - 1)) * W;
  const y = (v) => height - 4 - (v / max) * (height - 12);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="spark" role="img" aria-label={`máximo ${max.toFixed(1)} ${unit}`}>
      <line x1="0" x2={W} y1={height - 4} y2={height - 4} stroke="#e2e8f0" />
      {series.map((s) => (
        <polyline key={s.name} fill="none" stroke={s.color} strokeWidth="1.6" points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
      ))}
      <text x="4" y="11" fontSize="10" fill="#64748b">{max.toFixed(1)} {unit}</text>
    </svg>
  );
}
