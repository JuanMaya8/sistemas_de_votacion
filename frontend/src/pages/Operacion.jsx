// Operations dashboard (RT-4, RT-7, RT-9). Uses POLLING every 2 s on purpose: few viewers,
// aggregated data, 2 s of delay is fine — and it gives the system a third transport to compare.
import React, { useEffect, useRef, useState } from 'react';
import { getJson } from '../lib/api.js';
import Sparkline from '../components/Sparkline.jsx';

const nf = new Intl.NumberFormat('es-CO');
const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#4b5563', '#65a30d', '#ea580c'];
const HISTORY = 90; // 3 minutes

export default function Operacion() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const history = useRef({}); // instanceId -> { loop: [], msgs: [], conns: [] }
  const [, force] = useState(0);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const d = await getJson('/api/metrics/cluster');
        if (stopped) return;
        for (const m of d.instances) {
          const h = history.current[m.instanceId] || (history.current[m.instanceId] = { loop: [], msgs: [], conns: [] });
          h.loop.push(m.eventLoopDelayMs.p99); h.msgs.push(m.messagesPerSec); h.conns.push(m.connections.total);
          for (const k of Object.keys(h)) if (h[k].length > HISTORY) h[k].shift();
        }
        setData(d); setError(null); force((x) => x + 1);
      } catch (e) { if (!stopped) setError(e.message); }
    }
    poll();
    const t = setInterval(poll, 2000);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  const c = data?.cluster;
  const ids = data?.instances.map((m) => m.instanceId) || [];
  const series = (key) => ids.map((id, i) => ({ name: id, color: PALETTE[i % PALETTE.length], values: history.current[id]?.[key] || [] }));
  const reduction = c?.naiveTotal > c?.sentTotal ? (100 - (c.sentTotal * 100) / c.naiveTotal).toFixed(2) : null;

  return (
    <section>
      <div className="page-head">
        <div><h1>Tablero de operación</h1><p className="muted">Métricas de las {c?.instances ?? '…'} instancias, publicadas por cada una en Redis (actualiza cada 2 s).</p></div>
      </div>
      {error && <div className="alert alert-warn">No se pudieron leer las métricas: {error}</div>}
      {c && (
        <>
          <div className="stats">
            <div className="stat"><span>Instancias activas</span><strong>{c.instances}</strong></div>
            <div className="stat"><span>Conexiones públicas</span><strong>{nf.format(c.publicConnections)}</strong></div>
            <div className="stat"><span>Mensajes / s</span><strong>{nf.format(c.messagesPerSec)}</strong></div>
            <div className="stat"><span>Actas / min</span><strong>{nf.format(c.actasPerMin)}</strong></div>
            <div className="stat"><span>Event Loop p99 máx.</span><strong>{c.maxEventLoopP99Ms} ms</strong></div>
            <div className="stat"><span>INP p75 público</span><strong>{c.inpP75Ms ?? '—'} ms</strong><small>{c.inpSamples} muestras</small></div>
          </div>
          <div className="card">
            <h2>Fan-out: real vs ingenuo</h2>
            <p>Mensajes emitidos: <strong>{nf.format(c.sentTotal)}</strong> · Diseño ingenuo (1 por acta por cliente): <strong>{nf.format(c.naiveTotal)}</strong>
              {reduction && <> · Reducción <strong>{reduction} %</strong></>}</p>
            <p className="muted small">Actas aplicadas: {nf.format(c.actasApplied)} · ventanas publicadas: {nf.format(c.windows)} · mensajes por tópico: {nf.format(c.topicMessages)}</p>
          </div>
          <div className="grid-3">
            <div className="card"><h3>Retraso del Event Loop p99 (ms)</h3><Sparkline series={series('loop')} unit="ms" /></div>
            <div className="card"><h3>Mensajes enviados / s</h3><Sparkline series={series('msgs')} unit="msg/s" /></div>
            <div className="card"><h3>Conexiones por instancia</h3><Sparkline series={series('conns')} /></div>
          </div>
          <div className="card scroll-x">
            <table className="table">
              <thead><tr><th>Instancia</th><th>Redis</th><th>Públicas (SSE/WS)</th><th>Jurados</th><th>Verif.</th><th>Nuevas/s</th><th>Msg/s</th><th>EL p50/p99/max</th><th>RSS</th><th>KB/conn</th><th>Actas/min</th><th>Latencia publ.</th><th>Lentos</th></tr></thead>
              <tbody>
                {data.instances.map((m, i) => (
                  <tr key={m.instanceId}>
                    <td><span className="swatch" style={{ background: PALETTE[i % PALETTE.length] }} />{m.instanceId}</td>
                    <td>{m.redis === 'up' ? '✓' : '✗'}</td>
                    <td>{nf.format(m.connections.public)} ({m.connections.publicByTransport.sse}/{m.connections.publicByTransport.ws})</td>
                    <td>{m.connections.jurado}</td>
                    <td>{m.connections.verification}</td>
                    <td>{m.newConnectionsPerSec}</td>
                    <td>{m.messagesPerSec}</td>
                    <td>{m.eventLoopDelayMs.p50} / {m.eventLoopDelayMs.p99} / {m.eventLoopDelayMs.max}</td>
                    <td>{m.memory.rssMB} MB</td>
                    <td>{m.memory.perConnectionKB}</td>
                    <td>{m.actasPerMin}</td>
                    <td>{m.publishLatencyMs.avg} / {m.publishLatencyMs.max} ms</td>
                    <td>{m.laggingClients} · {m.totals.slowSnapshots} snap · {m.totals.slowDisconnects} desc.</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
