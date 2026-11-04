# Frontend — Preconteo electoral en tiempo real

React 18 + Vite, sin librerías adicionales (router por hash, gráficas SVG propias). Código en inglés, interfaz en español.

## Vistas
| Ruta | Audiencia | Transporte |
|---|---|---|
| `#/publico` | Público: acumulados por departamento / municipio / puesto, correcciones explicadas, INP | SSE (`fetch` + stream) con `lastEventId` |
| `#/jurado` | Jurados: formulario de acta, bandeja local, reintentos automáticos, correcciones | WebSocket (HTTP de respaldo) |
| `#/auditor` | Auditores: cola común en vivo, tomar caso con bloqueo, aprobar/rechazar/devolver | WebSocket |
| `#/coordinador` | Coordinación: presencia, caso actual y tiempo de cada auditor | WebSocket |
| `#/operacion` | Operación: instancias, Event Loop, mensajes/s, memoria, INP p75 | Polling 2 s |

## Estructura
```
src/
  main.jsx, App.jsx, styles.css
  lib/config.js        URL del backend (VITE_API_URL o mismo dominio)
  lib/backoff.js       backoff exponencial con full jitter (RF-10)
  lib/liveSocket.js    WebSocket con reconexión y request/response
  lib/publicStream.js  SSE con continuidad, 503 + Retry-After
  lib/outbox.js        bandeja local del jurado (RT-6)
  lib/inp.js           medición de INP con Event Timing API (RT-9)
  lib/catalog.js, ids.js, api.js
  pages/               Home, Publico, Jurado, Auditor, Coordinador, Operacion
  components/          ResultsBars, StatusBadge, Sparkline
public/sw.js           caché offline de la aplicación
docs/CONTRATO_API.md   contrato con el backend (mantener sincronizado)
```

## Desarrollo
```bash
npm install
# backend en :3000 (una instancia) o VITE_PROXY_TARGET=http://localhost para el docker compose
npm run dev        # http://localhost:5173
```
El servidor de desarrollo redirige `/api` y `/ws` al backend (ver `vite.config.js`).

## Producción
- **Misma URL que el backend (recomendado):** `npm run build` → `dist/`. El `docker-compose.yml` del backend monta `../frontend/dist` en Caddy.
- **Vercel / Netlify:** `VITE_API_URL=https://<dominio-backend>` en las variables del proyecto, comando `npm run build`, carpeta `dist`. En el backend, `CORS_ORIGIN=https://<dominio-frontend>`.

## Pruebas manuales para la sustentación
1. **Jurado sin red (RT-6):** DevTools → Network → *Offline*, enviar un acta (queda "En cola"), volver a *Online*: se transmite sola.
2. **Reenvío:** enviar, cortar la red antes de la confirmación y volver: la respuesta dice "Reenvío detectado (no se sumó de nuevo)".
3. **Dos auditores** en dos navegadores: uno toma un caso y en el otro desaparece de la cola al instante.
4. **Reconexión del público:** *Offline* 30 s y volver: llega un evento `catchup` (pie de la página: "recuperado tras reconexión").
5. **INP:** en un teléfono de gama baja (o DevTools → CPU 6x slowdown) durante la prueba de carga, interactuar con los selectores y leer el INP en el pie de `#/publico` y en `#/operacion`.
