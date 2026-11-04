// Public results page (SSE). Must stay usable on a low-end phone during the peak (RT-9):
// one state update per server message (every ~2 s), no heavy libraries, CSS-only bars.
import React, { useEffect, useMemo, useReducer, useState } from 'react';
import { subscribePublic } from '../lib/publicStream.js';
import { loadCatalog, FIELD_LABELS } from '../lib/catalog.js';
import { getJson } from '../lib/api.js';
import { onInp, currentInp, inpRating } from '../lib/inp.js';
import ResultsBars from '../components/ResultsBars.jsx';
import StatusBadge from '../components/StatusBadge.jsx';

const nf = new Intl.NumberFormat('es-CO');
const EMPTY = { values: {}, voters: 0, reported: 0, totalMesas: 0, pct: 0, label: '', corrections: [], lastId: null, updatedAt: null, kind: null };

function reducer(state, { type, event, data, id }) {
  if (type === 'reset') return EMPTY;
  if (type !== 'event') return state;
  if (event === 'snapshot') {
    return { ...state, ...data, values: { ...data.values }, lastId: id, updatedAt: Date.now(), kind: 'snapshot' };
  }
  if (event === 'update' || event === 'catchup') {
    const corrections = [...(data.corrections || []).slice().reverse(), ...state.corrections].slice(0, 15);
    return {
      ...state,
      label: data.label || state.label,
      values: { ...state.values, ...data.values },
      voters: data.voters ?? state.voters,
      reported: data.reported ?? state.reported,
      totalMesas: data.totalMesas ?? state.totalMesas,
      pct: data.pct ?? state.pct,
      corrections,
      lastId: id,
      updatedAt: Date.now(),
      kind: event,
    };
  }
  return state;
}

export default function Publico() {
  const [catalog, setCatalog] = useState(null);
  const [mun, setMun] = useState('');
  const [puesto, setPuesto] = useState('');
  const [puestos, setPuestos] = useState([]);
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const [conn, setConn] = useState({ state: 'connecting' });
  const [notice, setNotice] = useState(null);
  const [instance, setInstance] = useState(null);
  const [inp, setInp] = useState(currentInp());

  const topic = puesto ? `puesto:${puesto}` : mun ? `mun:${mun}` : 'dept';

  useEffect(() => { loadCatalog().then(setCatalog).catch(() => {}); return onInp(setInp); }, []);

  useEffect(() => {
    setPuesto('');
    setPuestos([]);
    if (mun) getJson(`/api/catalog/municipios/${mun}/puestos`).then((r) => setPuestos(r.puestos)).catch(() => {});
  }, [mun]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    const stop = subscribePublic(topic, {
      onEvent: (event, data, id) => {
        if (event === 'hello') return setInstance(data.instanceId);
        if (event === 'status') return setNotice(data.redis === 'down' ? data.message : null);
        dispatch({ type: 'event', event, data, id });
      },
      onState: setConn,
    });
    return stop;
  }, [topic]);

  const special = useMemo(() => ['BLANCO', 'NULO', 'NO_MARCADO'].map((f) => [FIELD_LABELS[f], state.values[f] || 0]), [state.values]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Resultados del preconteo</h1>
          <p className="muted">Reporte informativo en tiempo real. Se actualiza solo, sin recargar.</p>
        </div>
        <StatusBadge state={conn.state} seconds={conn.seconds} />
      </div>

      <div className="filters card">
        <label>Municipio
          <select value={mun} onChange={(e) => setMun(e.target.value)}>
            <option value="">Todo el departamento</option>
            {catalog?.municipios.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>Puesto
          <select value={puesto} onChange={(e) => setPuesto(e.target.value)} disabled={!mun}>
            <option value="">Todos los puestos</option>
            {puestos.map((p) => <option key={p.id} value={p.id}>Puesto {p.id} ({p.mesas} mesas)</option>)}
          </select>
        </label>
      </div>

      {notice && <div className="alert alert-warn">{notice}</div>}
      {conn.state === 'busy' && <div className="alert alert-warn">Mucha demanda en este momento. Reintentando en unos segundos…</div>}

      <div className="grid-2">
        <div className="card">
          <h2>{state.label || 'Cargando…'}</h2>
          <div className="progress-label">
            <strong>{state.pct?.toFixed ? state.pct.toFixed(2) : state.pct} %</strong> de mesas informadas
            <span className="muted"> ({nf.format(state.reported)} de {nf.format(state.totalMesas)})</span>
          </div>
          <div className="progress"><div style={{ width: `${state.pct || 0}%` }} /></div>
          {catalog && <ResultsBars values={state.values} candidates={catalog.candidates} />}
          <div className="kpis">
            <div><span>Sufragantes</span><strong>{nf.format(state.voters)}</strong></div>
            {special.map(([l, v]) => <div key={l}><span>{l}</span><strong>{nf.format(v)}</strong></div>)}
          </div>
        </div>

        <div className="card">
          <h2>Correcciones publicadas</h2>
          <p className="muted small">Si una cifra baja, aquí aparece el acta corregida que lo explica.</p>
          {state.corrections.length === 0 ? <p className="muted">Sin correcciones por ahora.</p> : (
            <ul className="log">{state.corrections.map((c, i) => <li key={`${c.acta}-${c.toVersion}-${i}`}>{c.message}</li>)}</ul>
          )}
        </div>
      </div>

      <p className="meta muted small">
        Última actualización: {state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString('es-CO') : '—'}
        {state.kind === 'catchup' && ' (recuperado tras reconexión)'} · Evento {state.lastId || '—'} · Instancia {instance || '—'} · INP {inp ?? '—'} ms ({inpRating(inp)})
      </p>
    </section>
  );
}
