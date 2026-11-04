// Coordinator view (RF-8): who is connected (on any of the 8 instances), what each auditor is
// working on and for how long. Presence expires by itself if an auditor disappears.
import React, { useEffect, useRef, useState } from 'react';
import { LiveSocket } from '../lib/liveSocket.js';
import StatusBadge from '../components/StatusBadge.jsx';

const dur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };

export default function Coordinador() {
  const [conn, setConn] = useState({ state: 'connecting' });
  const [auditors, setAuditors] = useState([]);
  const [queue, setQueue] = useState({ total: 0, assigned: [] });
  const [events, setEvents] = useState([]);
  const socketRef = useRef(null);

  useEffect(() => {
    let refreshTimer;
    const socket = new LiveSocket('/ws/verificacion', {
      onOpen: () => socket.send({ type: 'hello', role: 'coordinator', auditorId: 'coordinador', name: 'Coordinación' }),
      onState: (state, seconds) => setConn({ state, seconds }),
      onMessage: (msg) => {
        if (msg.type === 'welcome') { setQueue(msg); if (msg.presence) setAuditors(msg.presence); }
        if (msg.type === 'presence') setAuditors(msg.auditors);
        if (msg.type === 'queue_event' || msg.type === 'presence_event') {
          const text = msg.message || `${msg.event}: ${msg.caseId || (msg.auditors || []).join(', ')}${msg.name ? ` (${msg.name})` : ''}`;
          setEvents((e) => [{ at: Date.now(), text }, ...e].slice(0, 25));
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => socket.request({ type: 'queue' }).then((r) => r.ok && setQueue(r)).catch(() => {}), 300);
        }
      },
    });
    socketRef.current = socket;
    return () => { clearTimeout(refreshTimer); socket.close(); };
  }, []);

  const working = auditors.filter((a) => a.caseId).length;

  return (
    <section>
      <div className="page-head">
        <div><h1>Coordinación de verificación</h1><p className="muted">Presencia en vivo de los auditores, repartidos entre todas las instancias.</p></div>
        <StatusBadge state={conn.state} seconds={conn.seconds} />
      </div>
      <div className="stats">
        <div className="stat"><span>Auditores conectados</span><strong>{auditors.length}</strong></div>
        <div className="stat"><span>Trabajando un caso</span><strong>{working}</strong></div>
        <div className="stat"><span>Actas en cola</span><strong>{queue.total}</strong></div>
        <div className="stat"><span>Casos bloqueados</span><strong>{queue.assigned?.length || 0}</strong></div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h2>Auditores</h2>
          <table className="table">
            <thead><tr><th>Auditor</th><th>Instancia</th><th>Caso</th><th>Lleva</th><th>Último latido</th></tr></thead>
            <tbody>
              {auditors.map((a) => (
                <tr key={a.auditorId}>
                  <td>{a.name}<br /><span className="muted tiny">{a.auditorId}</span></td>
                  <td>{a.instanceId}</td>
                  <td>{a.caseId || <span className="muted">libre</span>}</td>
                  <td>{a.caseId ? dur(a.workingMs) : '—'}</td>
                  <td>hace {dur(Date.now() - a.lastSeen)}</td>
                </tr>
              ))}
              {auditors.length === 0 && <tr><td colSpan="5" className="muted">Nadie conectado.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>Actividad reciente</h2>
          <ul className="log">{events.map((e, i) => <li key={i}><span className="muted tiny">{new Date(e.at).toLocaleTimeString('es-CO')}</span> {e.text}</li>)}</ul>
        </div>
      </div>
    </section>
  );
}
