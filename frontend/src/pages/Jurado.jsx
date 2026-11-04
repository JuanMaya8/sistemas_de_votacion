// Jurado app (RT-6): works with an intermittent connection. Actas go to a local outbox first and
// are transmitted automatically (WebSocket, HTTP as fallback) until the server gives a FINAL answer.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LiveSocket } from '../lib/liveSocket.js';
import { postJson } from '../lib/api.js';
import { retryDelay } from '../lib/backoff.js';
import { randomId, hashFile } from '../lib/ids.js';
import { loadOutbox, saveOutbox, nextVersion } from '../lib/outbox.js';
import { loadCatalog, puestoOfMesa, municipioOfPuesto, actaIdFor, FIELD_LABELS, TOTAL_MESAS } from '../lib/catalog.js';
import StatusBadge from '../components/StatusBadge.jsx';

const FIELDS = ['C1', 'C2', 'C3', 'C4', 'BLANCO', 'NULO', 'NO_MARCADO'];
const emptyVotes = () => Object.fromEntries(FIELDS.map((f) => [f, '']));
const STATE_LABEL = { pending: 'En cola', sending: 'Enviando…', retry: 'Reintentará', done: 'Confirmada' };

export default function Jurado() {
  const [catalog, setCatalog] = useState(null);
  const [juradoId, setJuradoId] = useState(localStorage.getItem('jurado:id') || '');
  const [mesa, setMesa] = useState(localStorage.getItem('jurado:mesa') || '');
  const [votes, setVotes] = useState(emptyVotes());
  const [voters, setVoters] = useState('');
  const [photoHash, setPhotoHash] = useState('');
  const [items, setItems] = useState(loadOutbox());
  const [conn, setConn] = useState({ state: 'connecting' });
  const [online, setOnline] = useState(navigator.onLine);
  const [notice, setNotice] = useState(null);
  const itemsRef = useRef(items);
  const socketRef = useRef(null);
  const sendingRef = useRef(false);

  const update = (fn) => {
    const next = fn(itemsRef.current);
    itemsRef.current = next;
    saveOutbox(next);
    setItems(next);
  };

  useEffect(() => { loadCatalog().then(setCatalog).catch(() => {}); }, []);
  useEffect(() => { localStorage.setItem('jurado:id', juradoId); localStorage.setItem('jurado:mesa', mesa); }, [juradoId, mesa]);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    addEventListener('online', on); addEventListener('offline', off);
    const socket = new LiveSocket('/ws/jurado', {
      onOpen: () => {
        const id = localStorage.getItem('jurado:id');
        if (id) socket.send({ type: 'hello', juradoId: id });
      },
      onState: (state, seconds) => setConn({ state, seconds }),
      onMessage: (msg) => {
        if (msg.type === 'status') setNotice(msg.redis === 'down' ? msg.message : null);
        if (msg.type === 'welcome') setNotice(msg.redis === 'down' ? 'Servidor central no disponible: sus actas quedan en cola.' : null);
        if (msg.type === 'verification_result') {
          update((list) => list.map((it) => (it.acta.acta === msg.acta && it.acta.version === msg.version ? { ...it, verification: msg } : it)));
        }
      },
    });
    socketRef.current = socket;
    return () => { socket.close(); removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);

  useEffect(() => { if (conn.state === 'open' && juradoId) socketRef.current?.send({ type: 'hello', juradoId }); }, [juradoId, conn.state]);

  // Sender loop: one acta at a time, oldest first.
  useEffect(() => {
    const t = setInterval(async () => {
      if (sendingRef.current) return;
      const now = Date.now();
      const item = itemsRef.current.find((i) => (i.state === 'pending' || i.state === 'retry') && (i.nextAttemptAt || 0) <= now);
      if (!item) return;
      const socket = socketRef.current;
      const canWs = socket?.isOpen();
      if (!canWs && !navigator.onLine) return;
      sendingRef.current = true;
      update((list) => list.map((i) => (i.localId === item.localId ? { ...i, state: 'sending', attempts: (i.attempts || 0) + 1 } : i)));
      let ack;
      try {
        if (canWs) ack = await socket.request({ type: 'submit', acta: item.acta }, 10000);
        else { const r = await postJson('/api/actas', item.acta); ack = r.body; }
      } catch {
        ack = null; // no answer: we do NOT know if it was registered -> resend with the SAME idem
      }
      update((list) => list.map((i) => {
        if (i.localId !== item.localId) return i;
        if (ack?.final) return { ...i, state: 'done', status: ack.status, message: ack.message, duplicate: ack.duplicate, instanceId: ack.instanceId, confirmedAt: Date.now() };
        const wait = retryDelay(Math.min(i.attempts || 1, 4), ack?.retryAfterMs ? ack.retryAfterMs / 1000 : 0);
        return { ...i, state: 'retry', status: ack?.status || 'SIN_RESPUESTA', message: ack?.message || 'Sin confirmación del servidor. Se reenviará automáticamente con la misma clave (no se duplicará).', nextAttemptAt: Date.now() + wait };
      }));
      sendingRef.current = false;
    }, 500);
    return () => clearInterval(t);
  }, []);

  const mesaNum = Number(mesa);
  const validMesa = Number.isInteger(mesaNum) && mesaNum >= 1 && mesaNum <= TOTAL_MESAS;
  const puesto = validMesa ? puestoOfMesa(mesaNum) : null;
  const municipio = puesto ? municipioOfPuesto(puesto) : null;
  const actaId = validMesa ? actaIdFor(mesaNum) : '';
  const version = actaId ? nextVersion(items, actaId) : 1;
  const sum = useMemo(() => FIELDS.reduce((s, f) => s + (Number(votes[f]) || 0), 0), [votes]);
  const mismatch = voters !== '' && sum !== Number(voters);
  const candidateName = (id) => catalog?.candidates.find((c) => c.id === id)?.name || FIELD_LABELS[id] || id;

  function submit(e) {
    e.preventDefault();
    if (!juradoId || !validMesa) return;
    const acta = {
      acta: actaId, mesa: mesaNum, puesto, municipio, version, jurado: juradoId,
      ts_cierre: Math.floor(Date.now() / 1000),
      votos: Object.fromEntries(FIELDS.map((f) => [f, Number(votes[f]) || 0])),
      sufragantes: Number(voters) || 0,
      hash_foto: photoHash || undefined,
      idem: randomId(12), // created ONCE; every retry reuses it
    };
    update((list) => [{ localId: randomId(6), acta, state: 'pending', createdAt: Date.now(), attempts: 0 }, ...list]);
    setVotes(emptyVotes()); setVoters(''); setPhotoHash('');
  }

  function loadForCorrection(it) {
    setMesa(String(it.acta.mesa));
    setVotes(Object.fromEntries(FIELDS.map((f) => [f, String(it.acta.votos[f] ?? '')])));
    setVoters(String(it.acta.sufragantes));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const queued = items.filter((i) => i.state !== 'done').length;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Transmisión de actas</h1>
          <p className="muted">Si no hay señal, el acta queda guardada en este dispositivo y se envía sola cuando vuelva la red.</p>
        </div>
        <StatusBadge state={!online ? 'offline' : notice ? 'degraded' : conn.state} seconds={conn.seconds} />
      </div>
      {notice && <div className="alert alert-warn">{notice}</div>}

      <div className="grid-2">
        <form className="card form" onSubmit={submit}>
          <div className="row">
            <label>Código de jurado<input value={juradoId} onChange={(e) => setJuradoId(e.target.value.trim())} placeholder="JUR-88134" required /></label>
            <label>Mesa (1–{TOTAL_MESAS})<input type="number" min="1" max={TOTAL_MESAS} value={mesa} onChange={(e) => setMesa(e.target.value)} required /></label>
          </div>
          {validMesa && (
            <p className="muted small">Acta <strong>{actaId}</strong> · Puesto {puesto} · Municipio {catalog?.municipios[municipio - 1]?.name || municipio} · Se enviará como <strong>versión {version}</strong>{version > 1 && ' (corrección)'}</p>
          )}
          <div className="votes">
            {FIELDS.map((f) => (
              <label key={f}>{candidateName(f)}
                <input type="number" min="0" inputMode="numeric" value={votes[f]} onChange={(e) => setVotes({ ...votes, [f]: e.target.value })} required />
              </label>
            ))}
          </div>
          <div className="row">
            <label>Total sufragantes<input type="number" min="0" inputMode="numeric" value={voters} onChange={(e) => setVoters(e.target.value)} required /></label>
            <label>Foto del acta<input type="file" accept="image/*" capture="environment" onChange={async (e) => e.target.files[0] && setPhotoHash(await hashFile(e.target.files[0]))} /></label>
          </div>
          <p className={mismatch ? 'alert alert-warn small' : 'muted small'}>
            Suma de votos: <strong>{sum}</strong>{mismatch ? ` ≠ ${voters} sufragantes. El acta no cuadra y pasará a verificación humana.` : voters ? ' ✓ cuadra con los sufragantes.' : ''}
          </p>
          <button className="btn btn-primary" disabled={!validMesa || !juradoId}>Guardar y transmitir</button>
        </form>

        <div className="card">
          <h2>Bandeja de envío {queued > 0 && <span className="pill">{queued} pendiente(s)</span>}</h2>
          {items.length === 0 && <p className="muted">Aún no ha transmitido actas.</p>}
          <ul className="outbox">
            {items.slice(0, 30).map((it) => (
              <li key={it.localId} className={`ob ob-${it.state}`}>
                <div className="ob-head">
                  <strong>{it.acta.acta}</strong> <span className="muted">v{it.acta.version}</span>
                  <span className="pill">{STATE_LABEL[it.state]}</span>
                </div>
                {it.message && <p className="small">{it.message}</p>}
                {it.verification && <p className="small alert alert-info">{it.verification.message}</p>}
                <p className="muted tiny">Intentos: {it.attempts || 0}{it.instanceId ? ` · atendida por ${it.instanceId}` : ''} · clave {it.acta.idem}</p>
                {it.state === 'done' && <button type="button" className="btn btn-link" onClick={() => loadForCorrection(it)}>Enviar corrección</button>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
