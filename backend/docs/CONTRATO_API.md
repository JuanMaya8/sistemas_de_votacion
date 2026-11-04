# Contrato de API (frontend ↔ backend)

Este archivo es **el acuerdo entre frontend y backend**. Si alguien cambia un endpoint o un mensaje, actualiza este archivo en el mismo Pull Request.

- Código, nombres de campos y códigos de estado: **inglés**.
- Textos para el usuario (`message`): **español**. El frontend muestra `message` tal cual.
- Base URL: misma URL pública (Caddy enruta `/api`, `/ws` y `/health` a las 8 instancias). En desarrollo: `http://localhost:8080` o `http://localhost:3000`.
- Toda respuesta HTTP lleva la cabecera `X-Instance-Id` (RT-1).

## 1. HTTP

| Método y ruta | Uso |
|---|---|
| `GET /health` | `200 {status:"ok"}` o `503 {status:"degraded"}` si Redis no responde |
| `GET /health/live` | Vivacidad para el balanceador (siempre 200) |
| `GET /api/instance` | `{instanceId, isLeader, topics, lagging}` |
| `GET /api/catalog` | Candidatos, municipios (id, name, mesas, puestos) |
| `GET /api/catalog/municipios/:id/puestos` | `{puestos:[{id, mesas, firstMesa}]}` |
| `POST /api/actas` | Igual que `submit` por WebSocket (alternativa HTTP). Respuesta = `Ack` |
| `GET /api/actas/:acta` | Estado: `{appliedVersion, pendingVersion, rejectedVersion, votos}` |
| `GET /api/public/stream?topic=…&lastEventId=…` | **SSE** del público |
| `GET /api/public/snapshot?topic=…` | Fotografía completa (polling) |
| `GET /api/public/ranking?topic=…` | Ranking `[{field, votes}]` (ZSET) |
| `GET /api/metrics` | Métricas de la instancia que responde |
| `GET /api/metrics/cluster` | Métricas de todas las instancias + totales |
| `POST /api/metrics/inp` | `{value}` muestra de INP en ms (RT-9) |
| `GET /api/verification/queue` | Cola de verificación (depuración) |
| `GET /api/verification/presence` | Auditores conectados |
| `POST /api/debug/flood` | Solo con `DEBUG_ENDPOINTS=1`: `{topic, count, size}` |

### Tópicos
`dept` · `mun:<1..30>` · `puesto:<1..1842>`

### Acta (entrada)
```json
{ "acta": "E14-176-0562-03", "mesa": 562, "puesto": 176, "municipio": 3, "version": 1,
  "jurado": "JUR-88134", "ts_cierre": 1793577600,
  "votos": { "C1": 184, "C2": 97, "C3": 311, "C4": 20, "BLANCO": 22, "NULO": 9, "NO_MARCADO": 4 },
  "sufragantes": 647, "hash_foto": "9f2c…", "idem": "8f14e45fceea167a" }
```
- `idem` lo genera el **cliente una vez por envío** y se reutiliza en cada reintento.
- La mesa debe pertenecer al puesto y el puesto al municipio (ver catálogo).
- Regla contable: suma de `votos` = `sufragantes`; si no cuadra → `IN_REVIEW`.

### Ack (respuesta a un acta)
```json
{ "status": "REGISTERED", "final": true, "duplicate": false, "acta": "…", "idem": "…",
  "version": 1, "previousVersion": 0, "message": "Acta … registrada correctamente (versión 1).",
  "instanceId": "app-3" }
```
| `status` | `final` | Significado |
|---|---|---|
| `REGISTERED` | sí | Registrada y sumada |
| `CORRECTION_APPLIED` | sí | Versión anterior revertida y nueva aplicada |
| `ALREADY_APPLIED` | sí | Esa versión ya estaba |
| `STALE_VERSION` | sí | Llegó tarde: ya hay una versión mayor |
| `IN_REVIEW` | sí | No cuadra → verificación humana |
| `ALREADY_IN_REVIEW` | sí | Ya estaba en verificación |
| `REJECTED` | sí | Datos inválidos (`errors[]`) |
| `RATE_LIMITED` | **no** | Reintentar tras `retryAfterMs` |
| `UNAVAILABLE` | **no** | Redis caído: **NO quedó registrada**, reintentar |

`duplicate: true` = reenvío con el mismo `idem`; se devuelve la respuesta original.
Regla del frontend: **solo se borra un acta de la bandeja local si `final === true`**.

## 2. SSE público — `GET /api/public/stream?topic=mun:3&lastEventId=<id>`
Eventos (`event:`):
- `hello` → `{instanceId, topic}`
- `snapshot` (con `id`) → estado completo `{topic, label, values{C1..NO_MARCADO}, voters, reported, totalMesas, pct}`
- `catchup` (con `id`) → lo perdido mientras estuvo desconectado, fusionado: `{values (solo campos cambiados), corrections[], replayed, …}`
- `update` (con `id`) → cada ventana (2 s) si el tópico cambió: `{values (solo campos cambiados), voters, reported, pct, corrections[], actas, at}`
- `status` → `{redis:"down"|"up", message}`

`corrections[]`: `{acta, fromVersion, toVersion, delta, message}`. **Si un número baja, siempre viene con una corrección que lo explica.**

El cliente guarda el último `id` y al reconectar lo envía en `lastEventId`. Si recibe `503`, respeta `Retry-After`.

## 3. WebSocket jurado — `/ws/jurado`
Cliente → servidor:
- `{type:"hello", juradoId}`
- `{type:"submit", requestId, acta:{…}}`
- `{type:"status", requestId, actas:["E14-…"]}`

Servidor → cliente:
- `{type:"welcome", instanceId, redis}`
- `{type:"ack", requestId, …Ack}`
- `{type:"verification_result", acta, version, idem, status:"VERIFIED_APPROVED"|"VERIFIED_REJECTED", message}`
- `{type:"status", redis, message}`

## 4. WebSocket verificación — `/ws/verificacion`
Cliente → servidor:
- `{type:"hello", role:"auditor"|"coordinator", auditorId, name, resume?:{caseId, token, since}}`
- `{type:"heartbeat", caseId?, token?, lastActivity}` cada 10 s (renueva el bloqueo y la presencia)
- `{type:"take", requestId, caseId}` → `reply {ok, token, lockTtlMs, case}` o `{ok:false, code:"TAKEN"}`
- `{type:"release", requestId, caseId, token}`
- `{type:"resolve", requestId, caseId, token, decision:"approve"|"reject", votos?, sufragantes?, note?}`
- `{type:"queue", requestId}`

Servidor → cliente:
- `{type:"welcome", instanceId, role, total, queue[], assigned[], presence?}`
- `{type:"reply", requestId, ok, message, …}`
- `{type:"queue_event", event:"added"|"taken"|"released"|"resolved"|"reclaimed"|"superseded", caseId, auditorId?, name?, case?, message?}`
- `{type:"lock_lost", caseId, message}` · `{type:"idle_warning", caseId, message}`
- `{type:"presence", auditors:[{auditorId, name, instanceId, caseId, workingMs, lastSeen}]}` (solo coordinador, cada 3 s)

## 5. WebSocket público (solo para medir) — `/ws/public?topic=…&lastEventId=…`
Mismos eventos que SSE, en JSON: `{type:"update", id, data}`.
