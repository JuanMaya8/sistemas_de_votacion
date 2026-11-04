import React, { useState } from 'react';
import { getJson } from '../lib/api.js';

const VIEWS = [
  ['publico', 'Resultados públicos', 'Acumulados en vivo por departamento, municipio o puesto (SSE).'],
  ['jurado', 'Jurados', 'Transmisión de actas con cola local y reintento automático (WebSocket).'],
  ['auditor', 'Auditores', 'Cola de actas dudosas con bloqueo exclusivo (WebSocket).'],
  ['coordinador', 'Coordinación', 'Presencia de auditores y reparto del trabajo.'],
  ['operacion', 'Operación', 'Instancias, Event Loop, mensajes por segundo, INP.'],
];

export default function Home() {
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);

  // RT-1 / RT-2 demo: consecutive requests land on different instances (no sticky sessions).
  async function probe() {
    setBusy(true);
    const out = [];
    for (let i = 0; i < 12; i++) {
      try { const r = await getJson(`/api/instance?i=${i}`); out.push(r.instanceId); } catch { out.push('error'); }
    }
    setHits(out);
    setBusy(false);
  }
  const distinct = new Set(hits.filter((h) => h !== 'error')).size;

  return (
    <section>
      <div className="hero">
        <h1>Preconteo electoral en tiempo real</h1>
        <p>6.400 mesas · 1.842 puestos · 8 instancias sin sesiones pegajosas coordinadas por Redis.</p>
      </div>
      <div className="cards">
        {VIEWS.map(([k, t, d]) => (
          <a key={k} className="card link-card" href={`#/${k}`}><h2>{t}</h2><p className="muted">{d}</p></a>
        ))}
      </div>
      <div className="card">
        <h2>¿Qué instancia me atiende?</h2>
        <p className="muted small">Hace 12 peticiones seguidas. Sin afinidad, deben caer en instancias distintas.</p>
        <button className="btn" onClick={probe} disabled={busy}>{busy ? 'Consultando…' : 'Probar balanceo'}</button>
        {hits.length > 0 && <p><strong>{distinct}</strong> instancias distintas: {hits.join(' · ')}</p>}
      </div>
    </section>
  );
}
