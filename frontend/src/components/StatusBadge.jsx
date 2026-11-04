import React from 'react';

const LABELS = {
  open: ['Conectado', 'ok'],
  connecting: ['Conectando…', 'warn'],
  waiting: ['Reintentando', 'warn'],
  busy: ['Servidor ocupado', 'warn'],
  closed: ['Desconectado', 'bad'],
  slow: ['Conexión lenta', 'warn'],
  error: ['Error', 'bad'],
  offline: ['Sin red', 'bad'],
  degraded: ['Servidor central caído', 'bad'],
};

export default function StatusBadge({ state, seconds }) {
  const [label, tone] = LABELS[state] || [state, 'warn'];
  return (
    <span className={`badge badge-${tone}`} role="status">
      <span className="dot" /> {label}{state === 'waiting' && seconds != null ? ` en ${seconds} s` : ''}
    </span>
  );
}
