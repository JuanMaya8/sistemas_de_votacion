// Verification console (RF-7). The shared queue updates live on every console; taking a case locks
// it for everyone else. The lock is renewed by the heartbeat ONLY while the auditor is active.
import React, { useEffect, useRef, useState } from 'react';
import { LiveSocket } from '../lib/liveSocket.js';
import { FIELD_LABELS } from '../lib/catalog.js';
import StatusBadge from '../components/StatusBadge.jsx';

const FIELDS = ['C1', 'C2', 'C3', 'C4', 'BLANCO', 'NULO', 'NO_MARCADO'];
const CASE_KEY = 'auditor:case';
const ago = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);

export default function Auditor() {
  const [auditorId, setAuditorId] = useState(localStorage.getItem('auditor:id') || '');
  const [name, setName] = useState(localStorage.getItem('auditor:name') || '');
  const [joined, setJoined] = useState(!!localStorage.getItem('auditor:id'));
  const [conn, setConn] = useState({ state: 'connecting' });
  const [queue, setQueue] = useState({ total: 0, queue: [], assigned: [] });
  const [current, setCurrent] = useState(() => JSON.parse(sessionStorage.getItem(CASE_KEY) || 'null'));
  const [edit, setEdit] = useState(() => (current ? { votos: Object.fromEntries(FIELDS.map((f) => [f, String(current.case?.votos?.[f] ?? 0)])), sufragantes: String(current.case?.sufragantes ?? 0) } : null));
  const [note, setNote] = useState('');
  const [banner, setBanner] = useState(null);
  const [instance, setInstance] = useState(null);
  const [, tick] = useState(0);
  const socketRef = useRef(null);
  const currentRef = useRef(current);
  const lastActivity = useRef(Date.now());
  const refreshTimer = useRef(null);

  const setCase = (c) => {
    currentRef.current = c;
    setCurrent(c);
    if (c) sessionStorage.setItem(CASE_KEY, JSON.stringify(c)); else sessionStorage.removeItem(CASE_KEY);
    setEdit(c ? { votos: Object.fromEntries(FIELDS.map((f) => [f, String(c.case?.votos?.[f] ?? 0)])), sufragantes: String(c.case?.sufragantes ?? 0) } : null);
  };

  useEffect(() => {
    const mark = () => { lastActivity.current = Date.now(); };
    addEventListener('pointerdown', mark); addEventListener('keydown', mark);
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => { removeEventListener('pointerdown', mark); removeEventListener('keydown', mark); clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!joined) return undefined;
    const refresh = () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => socketRef.current?.request({ type: 'queue' }).then((r) => r.ok && setQueue(r)).catch(() => {}), 250);
    };
    const socket = new LiveSocket('/ws/verificacion', {
      onOpen: () => {
        const c = currentRef.current;
        socket.send({ type: 'hello', role: 'auditor', auditorId, name, resume: c ? { caseId: c.caseId, token: c.token, since: c.since } : undefined });
      },
      onState: (state, seconds) => setConn({ state, seconds }),
      onMessage: (msg) => {
        const mine = currentRef.current;
        switch (msg.type) {
          case 'welcome':
            setInstance(msg.instanceId);
            setQueue(msg);
            if (mine && !msg.resumed) { setBanner({ tone: 'warn', text: `Su bloqueo sobre ${mine.caseId} expiró durante la desconexión.` }); setCase(null); }
            break;
          case 'queue_event':
            if (mine && msg.caseId === mine.caseId && (msg.event === 'reclaimed' || msg.event === 'superseded')) {
              setBanner({ tone: 'warn', text: msg.message }); setCase(null);
            }
            if (msg.event === 'added' && msg.case) setQueue((q) => ({ ...q, total: q.total + 1, queue: [...q.queue, msg.case].sort((a, b) => a.score - b.score) }));
            else if (msg.event === 'taken') setQueue((q) => ({ ...q, queue: q.queue.filter((c) => c.caseId !== msg.caseId), assigned: [...q.assigned.filter((a) => a.caseId !== msg.caseId), { caseId: msg.caseId, auditorId: msg.auditorId, name: msg.name, since: msg.at }] }));
            refresh();
            break;
          case 'lock_lost':
            setBanner({ tone: 'warn', text: msg.message }); setCase(null); refresh();
            break;
          case 'idle_warning':
            setBanner({ tone: 'warn', text: msg.message });
            break;
          case 'status':
            setBanner(msg.redis === 'down' ? { tone: 'warn', text: msg.message } : null);
            break;
          default: break;
        }
      },
    });
    socketRef.current = socket;
    const hb = setInterval(() => {
      const c = currentRef.current;
      socket.send({ type: 'heartbeat', caseId: c?.caseId, token: c?.token, lastActivity: lastActivity.current });
      if (c) { const next = { ...c, renewedAt: Date.now() }; currentRef.current = next; setCurrent(next); sessionStorage.setItem(CASE_KEY, JSON.stringify(next)); }
    }, 10000);
    return () => { clearInterval(hb); socket.close(); };
  }, [joined]);

  async function take(caseId) {
    try {
      const r = await socketRef.current.request({ type: 'take', caseId });
      if (r.ok) { setBanner(null); setCase({ caseId, token: r.token, since: Date.now(), renewedAt: Date.now(), lockTtlMs: r.lockTtlMs, case: r.case }); }
      else setBanner({ tone: 'warn', text: r.message });
    } catch { setBanner({ tone: 'warn', text: 'Sin conexión. Intente de nuevo.' }); }
  }

  async function resolve(decision) {
    const c = currentRef.current;
    const body = { type: 'resolve', caseId: c.caseId, token: c.token, decision, note };
    if (decision === 'approve') {
      body.votos = Object.fromEntries(FIELDS.map((f) => [f, Number(edit.votos[f]) || 0]));
      body.sufragantes = Number(edit.sufragantes) || 0;
    }
    try {
      const r = await socketRef.current.request(body);
      setBanner({ tone: r.ok ? 'ok' : 'warn', text: r.message });
      if (r.ok || r.code === 'LOCK_LOST' || r.code === 'NOT_AVAILABLE') { setCase(null); setNote(''); }
    } catch { setBanner({ tone: 'warn', text: 'Sin conexión: su decisión no se envió. Reintente.' }); }
  }

  async function release() {
    const c = currentRef.current;
    try { const r = await socketRef.current.request({ type: 'release', caseId: c.caseId, token: c.token }); setBanner({ tone: 'ok', text: r.message }); } catch { /* lock will expire */ }
    setCase(null);
  }

  if (!joined) {
    return (
      <section className="narrow">
        <h1>Consola de verificación</h1>
        <form className="card form" onSubmit={(e) => { e.preventDefault(); localStorage.setItem('auditor:id', auditorId); localStorage.setItem('auditor:name', name); setJoined(true); }}>
          <label>Código de auditor<input value={auditorId} onChange={(e) => setAuditorId(e.target.value.trim())} placeholder="AUD-017" required /></label>
          <label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Laura Gómez" required /></label>
          <button className="btn btn-primary">Ingresar</button>
        </form>
      </section>
    );
  }

  const sum = edit ? FIELDS.reduce((s, f) => s + (Number(edit.votos[f]) || 0), 0) : 0;
  const cuadra = edit && sum === Number(edit.sufragantes);
  const lockLeft = current ? Math.max(0, Math.round(((current.renewedAt || current.since) + (current.lockTtlMs || 30000) - Date.now()) / 1000)) : 0;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Verificación de actas dudosas</h1>
          <p className="muted">{name} ({auditorId}) · instancia {instance || '—'} · <button className="btn btn-link" onClick={() => { localStorage.removeItem('auditor:id'); location.reload(); }}>Salir</button></p>
        </div>
        <StatusBadge state={conn.state} seconds={conn.seconds} />
      </div>
      {banner && <div className={`alert alert-${banner.tone}`}>{banner.text}</div>}

      <div className="grid-2">
        <div className="card">
          <h2>Cola común <span className="pill">{queue.total} en espera</span></h2>
          {queue.queue.length === 0 && <p className="muted">No hay actas por verificar.</p>}
          <ul className="queue">
            {queue.queue.slice(0, 50).map((c) => (
              <li key={c.caseId}>
                <div><strong>{c.acta}</strong> <span className="muted">v{c.version} · mesa {c.mesa}</span><br />
                  <span className="small">Descuadre: <strong>{c.discrepancy}</strong> votos · hace {ago(Date.now() - c.receivedAt)}</span></div>
                <button className="btn" disabled={!!current || conn.state !== 'open'} onClick={() => take(c.caseId)}>Tomar</button>
              </li>
            ))}
          </ul>
          {queue.assigned.length > 0 && (<>
            <h3>En revisión por otros auditores</h3>
            <ul className="queue taken">
              {queue.assigned.map((a) => <li key={a.caseId}><span>🔒 {a.caseId}</span><span className="muted small">{a.name || a.auditorId} · {ago(Date.now() - a.since)}</span></li>)}
            </ul>
          </>)}
        </div>

        <div className="card">
          <h2>Mi caso</h2>
          {!current && <p className="muted">Tome un caso de la cola. Nadie más podrá trabajarlo mientras usted esté activo.</p>}
          {current && edit && (
            <div className="form">
              <p><strong>{current.case?.acta}</strong> · versión {current.case?.version} · jurado {current.case?.jurado}</p>
              <p className="muted small">Foto: {current.case?.hash_foto || 'sin hash'} · bloqueo vigente {lockLeft} s (se renueva solo mientras usted trabaja)</p>
              <div className="votes">
                {FIELDS.map((f) => (
                  <label key={f}>{FIELD_LABELS[f] || f}
                    <input type="number" min="0" value={edit.votos[f]} onChange={(e) => setEdit({ ...edit, votos: { ...edit.votos, [f]: e.target.value } })} />
                  </label>
                ))}
                <label>Sufragantes<input type="number" min="0" value={edit.sufragantes} onChange={(e) => setEdit({ ...edit, sufragantes: e.target.value })} /></label>
              </div>
              <p className={cuadra ? 'small' : 'small alert alert-warn'}>Suma {sum} {cuadra ? '= sufragantes ✓' : `≠ ${edit.sufragantes}: corrija los valores según la foto para aprobar`}</p>
              <label>Observación (para rechazo)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Foto ilegible, falta firma…" /></label>
              <div className="actions">
                <button className="btn btn-primary" disabled={!cuadra} onClick={() => resolve('approve')}>Aprobar</button>
                <button className="btn btn-danger" onClick={() => resolve('reject')}>Rechazar</button>
                <button className="btn" onClick={release}>Devolver a la cola</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
