// Same deterministic mapping as the backend catalog (mesa -> puesto -> municipio).
import { getJson } from './api.js';

export const TOTAL_MESAS = 6400;
export const TOTAL_PUESTOS = 1842;
export const TOTAL_MUNICIPIOS = 30;
export const puestoOfMesa = (mesa) => Math.floor(((mesa - 1) * TOTAL_PUESTOS) / TOTAL_MESAS) + 1;
export const municipioOfPuesto = (p) => Math.floor(((p - 1) * TOTAL_MUNICIPIOS) / TOTAL_PUESTOS) + 1;

export const actaIdFor = (mesa) => `E14-${String(puestoOfMesa(mesa)).padStart(3, '0')}-${String(mesa).padStart(4, '0')}-03`;

export const FIELD_LABELS = { BLANCO: 'Votos en blanco', NULO: 'Votos nulos', NO_MARCADO: 'No marcados' };

const CACHE_KEY = 'catalog:v1';

/** Catalog cached in localStorage so the jurado app works offline after the first load. */
export async function loadCatalog() {
  try {
    const c = await getJson('/api/catalog');
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    return c;
  } catch (err) {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) return JSON.parse(cached);
    throw err;
  }
}
