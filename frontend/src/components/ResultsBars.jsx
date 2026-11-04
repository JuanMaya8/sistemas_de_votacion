import React from 'react';

const COLORS = { C1: '#1f9d55', C2: '#2a6fdb', C3: '#d97706', C4: '#c2410c' };
const nf = new Intl.NumberFormat('es-CO');

/** Candidate ranking with horizontal bars. Pure CSS widths: cheap to repaint on low-end phones. */
export default function ResultsBars({ values, candidates }) {
  const rows = candidates.map((c) => ({ ...c, votes: values[c.id] || 0 })).sort((a, b) => b.votes - a.votes);
  const valid = rows.reduce((s, r) => s + r.votes, 0) + (values.BLANCO || 0);
  const max = Math.max(1, ...rows.map((r) => r.votes));
  return (
    <ol className="bars">
      {rows.map((r, i) => (
        <li key={r.id}>
          <div className="bar-head">
            <span className="pos">{i + 1}</span>
            <span className="name">{r.name}<small>{r.party}</small></span>
            <span className="num">{nf.format(r.votes)}<small>{valid ? ((r.votes * 100) / valid).toFixed(2) : '0.00'} %</small></span>
          </div>
          <div className="track"><div className="fill" style={{ width: `${(r.votes * 100) / max}%`, background: COLORS[r.id] || '#64748b' }} /></div>
        </li>
      ))}
    </ol>
  );
}
