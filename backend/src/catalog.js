// Synthetic but deterministic electoral catalog: 6,400 mesas, 1,842 puestos, 30 municipios.
// Every instance computes the same catalog in memory, so no instance needs to ask another one.

export const TOTAL_MESAS = 6400;
export const TOTAL_PUESTOS = 1842;
export const TOTAL_MUNICIPIOS = 30;

export const CANDIDATES = [
  { id: 'C1', name: 'Candidata Ana Rojas', party: 'Movimiento Verde' },
  { id: 'C2', name: 'Candidato Luis Peña', party: 'Partido Cívico' },
  { id: 'C3', name: 'Candidata Marta Gil', party: 'Alianza Regional' },
  { id: 'C4', name: 'Candidato Jorge Ruiz', party: 'Frente Popular' },
];
export const SPECIAL_FIELDS = ['BLANCO', 'NULO', 'NO_MARCADO'];
export const VOTE_FIELDS = [...CANDIDATES.map((c) => c.id), ...SPECIAL_FIELDS];

const MUNICIPIO_NAMES = [
  'Capital', 'Villa del Río', 'San Andrés', 'Puerto Alegre', 'La Esperanza', 'El Carmen', 'Santa Rosa',
  'Los Andes', 'Buenavista', 'San José', 'Pueblo Nuevo', 'La Unión', 'El Tambo', 'Florencia', 'Mirador',
  'Las Palmas', 'Villanueva', 'Santa Ana', 'El Rosal', 'Guadalupe', 'Monteverde', 'La Victoria', 'Ríoclaro',
  'Belén', 'San Pedro', 'Altamira', 'El Retiro', 'Bellavista', 'Primavera', 'Arboleda',
];

export const puestoOfMesa = (mesa) => Math.floor(((mesa - 1) * TOTAL_PUESTOS) / TOTAL_MESAS) + 1;
export const municipioOfPuesto = (puesto) => Math.floor(((puesto - 1) * TOTAL_MUNICIPIOS) / TOTAL_PUESTOS) + 1;

const mesasPerPuesto = new Map();
const mesasPerMunicipio = new Map();
const puestosPerMunicipio = new Map();
for (let mesa = 1; mesa <= TOTAL_MESAS; mesa++) {
  const p = puestoOfMesa(mesa);
  const m = municipioOfPuesto(p);
  mesasPerPuesto.set(p, (mesasPerPuesto.get(p) || 0) + 1);
  mesasPerMunicipio.set(m, (mesasPerMunicipio.get(m) || 0) + 1);
}
for (let p = 1; p <= TOTAL_PUESTOS; p++) {
  const m = municipioOfPuesto(p);
  if (!puestosPerMunicipio.has(m)) puestosPerMunicipio.set(m, []);
  puestosPerMunicipio.get(m).push(p);
}

export function mesasFirstOfPuesto(puesto) {
  // First mesa of a puesto (inverse of puestoOfMesa), handy for the UI and the load test.
  let lo = 1, hi = TOTAL_MESAS;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (puestoOfMesa(mid) < puesto) lo = mid + 1; else hi = mid; }
  return lo;
}

export function totalMesasOf(topic) {
  if (topic === 'dept') return TOTAL_MESAS;
  const [kind, idRaw] = topic.split(':');
  const id = Number(idRaw);
  if (kind === 'mun') return mesasPerMunicipio.get(id) || 0;
  if (kind === 'puesto') return mesasPerPuesto.get(id) || 0;
  if (kind === 'mesa') return 1;
  return 0;
}

export function isValidTopic(topic) {
  if (topic === 'dept') return true;
  const m = /^(mun|puesto):(\d+)$/.exec(topic || '');
  if (!m) return false;
  const id = Number(m[2]);
  return m[1] === 'mun' ? id >= 1 && id <= TOTAL_MUNICIPIOS : id >= 1 && id <= TOTAL_PUESTOS;
}

export function topicLabel(topic) {
  if (topic === 'dept') return 'Departamento';
  const [kind, id] = topic.split(':');
  if (kind === 'mun') return `Municipio ${MUNICIPIO_NAMES[Number(id) - 1] || id}`;
  if (kind === 'puesto') return `Puesto ${id}`;
  return topic;
}

export function catalogSummary() {
  return {
    totalMesas: TOTAL_MESAS,
    totalPuestos: TOTAL_PUESTOS,
    candidates: CANDIDATES,
    specialFields: SPECIAL_FIELDS,
    municipios: Array.from({ length: TOTAL_MUNICIPIOS }, (_, i) => ({
      id: i + 1,
      name: MUNICIPIO_NAMES[i],
      mesas: mesasPerMunicipio.get(i + 1),
      puestos: puestosPerMunicipio.get(i + 1).length,
    })),
  };
}

export function puestosOfMunicipio(mun) {
  return (puestosPerMunicipio.get(mun) || []).map((p) => ({ id: p, mesas: mesasPerPuesto.get(p), firstMesa: mesasFirstOfPuesto(p) }));
}

export const municipioName = (id) => MUNICIPIO_NAMES[id - 1];
