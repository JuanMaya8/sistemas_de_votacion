# Backend — Preconteo electoral en tiempo real

Node.js 20+ · `ws` (WebSocket) · SSE nativo · Redis (`ioredis`) · Caddy (balanceador) · Docker Compose.
Código en inglés, mensajes al usuario en español.

## Estructura
```
src/
  index.js               servidor HTTP + WebSocket (una instancia sin estado)
  config.js              configuración por variables de entorno
  keys.js                espacio de claves y canales de Redis
  catalog.js             catálogo: 6.400 mesas, 1.842 puestos, 30 municipios, 4 candidatos
  redis.js               conexiones, scripts Lua registrados, estado de salud
  lua/applyActa.lua      aplicación atómica del acta (RF-1, RF-2, RF-3)
  lua/scripts.js         bloqueos, liderazgo, publicación con historial, rate limit
  services/actas.js      validación, rate limit, respuesta en español
  services/aggregator.js ventana de agregación (líder), barridos
  services/verification.js cola, bloqueos, presencia (RF-7, RF-8)
  realtime/publicHub.js  tópicos, fan-out por lotes, continuidad, contrapresión (RF-4/5/6/9)
  realtime/sse.js        endpoint SSE público
  realtime/wsServer.js   WebSocket jurados, verificación y público (comparación)
  realtime/admission.js  control de admisión contra avalanchas (RF-10)
  metrics/metrics.js     Event Loop, conexiones, mensajes/s, memoria (RT-4, RT-7)
  routes/api.js          rutas HTTP
loadtest/                pruebas de carga reproducibles (RT-8) — ver loadtest/README.md
docs/CONTRATO_API.md     contrato con el frontend
docs/INFORME_TECNICO.md  borrador del informe (justificaciones RF/RT)
Dockerfile · docker-compose.yml (8 instancias + Redis + Caddy) · Caddyfile
```

## Correr en local (sin Docker)
```bash
# Redis local (o: docker run -p 6379:6379 redis:7.4-alpine)
npm install
PORT=3001 INSTANCE_ID=app-1 npm start
PORT=3002 INSTANCE_ID=app-2 npm start   # segunda terminal: comprueba que se coordinan por Redis
curl localhost:3001/health
```

## Correr las 8 instancias en local (Docker)
```bash
cp .env.example .env
docker compose up -d --build
curl -i localhost/api/instance     # repetir: X-Instance-Id cambia (round robin, sin afinidad)
```
El frontend compilado (`../frontend/dist`) queda servido en `http://localhost/`.

## Despliegue en la nube (RT-1, RT-10)
Recomendado: **una VM** (Azure for Students, GCP con crédito, AWS EC2 u Oracle Cloud Free) de 4 vCPU / 8–16 GB con Ubuntu 24.04.

1. Crear la VM y abrir los puertos **80 y 443**.
2. Dominio gratis: crear un subdominio en https://www.duckdns.org apuntando a la IP pública (ej. `preconteo-grupo.duckdns.org`).
3. En la VM:
   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone https://github.com/JuanMaya8/sistemas_de_votacion.git && cd sistemas_de_votacion
   (cd frontend && npm install && npm run build)        # genera frontend/dist
   cd backend && cp .env.example .env && nano .env      # DOMAIN=preconteo-grupo.duckdns.org
   docker compose up -d --build
   docker compose ps                                     # 8 apps + redis + caddy
   ```
4. Caddy obtiene el certificado HTTPS solo. URL pública: `https://preconteo-grupo.duckdns.org`.
5. Actualizar después de un merge: `git pull && (cd ../frontend && npm run build) && docker compose up -d --build`.

Alternativa: frontend en Vercel/Netlify con `VITE_API_URL=https://<dominio-backend>` y `CORS_ORIGIN=https://<dominio-frontend>` en `.env`.

## Variables de entorno principales
| Variable | Defecto | Descripción |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Conexión a Redis |
| `INSTANCE_ID` | hostname | Identificador visible (RT-1) |
| `WINDOW_MS` | 2000 | Ventana de agregación del público |
| `FANOUT_BATCH_SIZE` | 500 | Tamaño de lote del fan-out |
| `HISTORY_MAXLEN` | 600 | Entradas de historial por tópico |
| `LOCK_TTL_MS` | 30000 | Vida del bloqueo de un caso |
| `AUDITOR_IDLE_LIMIT_MS` | 300000 | Inactividad tras la cual no se renueva el bloqueo |
| `SLOW_SOFT_BYTES` / `SLOW_HARD_BYTES` | 64 KB / 512 KB | Umbrales de contrapresión |
| `MAX_NEW_CONN_PER_SEC` | 400 | Control de admisión por instancia |
| `DEBUG_ENDPOINTS` | 0 | `1` habilita `/api/debug/flood` |

Detalle de mensajes y eventos: `docs/CONTRATO_API.md`.
