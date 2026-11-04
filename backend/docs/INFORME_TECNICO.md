# Informe técnico — Preconteo en tiempo real

> Borrador base. Las secciones marcadas con **[MEDIR]** se completan con los resultados de las pruebas del despliegue en la nube (ver `loadtest/README.md`).

## 1. Arquitectura

```
Jurados (WS) ─┐                       ┌── Redis ──────────────────────────────┐
Auditores (WS)├─► Caddy (round robin, ├─ Lua applyActa (atómico)               │
Público (SSE) ┘   sin afinidad) ──►   ├─ Streams: cambios + historial por tópico│
                  app-1 … app-8       ├─ Pub/Sub: bp:topic:<t>, bp:verify      │
                  (sin estado,        ├─ Locks, presencia, rate limit, métricas│
                   no se hablan)      └────────────────────────────────────────┘
```

- 8 instancias Node.js idénticas detrás de Caddy, **sin sesiones pegajosas** (RT-1, RT-2).
- Ninguna instancia conoce a otra: toda coordinación pasa por Redis (RT-3), incluida la elección de líder del agregador.
- Transportes (RT-5): **WebSocket** para jurados y auditores, **SSE** para el público, **polling** para el tablero de operación.

## 2. Elección de transporte por audiencia (sección 7) [MEDIR]

| Audiencia | Transporte | Por qué |
|---|---|---|
| Jurados | WebSocket (+ POST HTTP de respaldo) | Bidireccional: envía acta y recibe ack, corrección o rechazo en el mismo canal; el resultado de la verificación llega empujado. |
| Auditores | WebSocket | Colaborativo: tomar/soltar casos y ver a los demás al instante. |
| Público | SSE | Unidireccional; reconexión y `Last-Event-ID` nativos del navegador; HTTP normal (proxies, HTTP/2); menos memoria por conexión que WS en el servidor. |
| Operación | Polling cada 2 s | Pocos clientes, datos agregados, tolera 2 s de retraso. |

Medición: `node loadtest/compare-transports.js` (mensajes, KB, peticiones, retraso p50/p95 para SSE vs WS vs polling). Pegar aquí la tabla.

## 3. Requerimientos funcionales

### RF-1 Idempotencia
- El cliente genera `idem` una vez y lo reutiliza en cada reintento.
- El script Lua `applyActa` revisa `{e}:idem:<idem>`; si existe, devuelve **la misma respuesta original** con `duplicate:true` (nunca silencio).
- La respuesta se guarda (`SET … EX 48h`) **dentro del mismo script** que suma los votos. Por eso, si el servidor muere entre registrar y confirmar: el registro y la respuesta quedaron juntos; el jurado no recibió ack, reintenta con el mismo `idem` (desde cualquier instancia) y recibe `REGISTERED (reenvío)`. No hay doble suma.
- Si la clave `idem` expirara antes del reintento, la segunda defensa es la **versión**: la misma versión de la misma acta responde `ALREADY_APPLIED` y no suma.

### RF-2 Correcciones y convergencia
- Por acta se guarda `version` aplicada y los votos aplicados. Una versión mayor calcula `diff = nuevos − anteriores` y lo aplica a los 4 niveles (revierte la anterior).
- Una versión menor o igual responde `STALE_VERSION`/`ALREADY_APPLIED` sin tocar nada.
- El estado final es el de la **versión máxima** de cada acta → depende solo del conjunto recibido, no del orden. Verificado por `loadtest/jornada.js` (envía v3 antes que v2 y compara el total).

### RF-3 Atomicidad jerárquica
- Un único script Lua actualiza mesa, puesto, municipio, departamento (HASH con `HINCRBY`), los rankings (ZSET con `ZINCRBY`), `_reported` (mesas informadas) y añade el cambio al stream.
- Redis ejecuta un script sin intercalar comandos de otros clientes: no existe un instante intermedio visible.
- Varios comandos seguidos desde la app no bastan: entre comando y comando otro cliente puede leer (estado parcial) y, si la app muere a la mitad, el acumulado queda inconsistente para siempre. `MULTI` no sirve para lógica condicional (versión, idem) porque no permite leer y decidir dentro de la transacción.
- Restricción: el script debe ser corto (bloquea Redis mientras corre) y en Redis Cluster todas las claves deben ir en el mismo slot → todas usan el hash tag `{e}`.

### RF-4 Fan-out sin bloquear el Event Loop
- **Agregación por ventana**: el líder lee cada 2 s los cambios nuevos y publica **un mensaje por tópico cambiado**, con solo los campos que cambiaron (delta mínimo, valores absolutos).
- En cada instancia el envío se hace en lotes de 500 con `setImmediate` entre lotes; el frame se serializa una sola vez.
- Retraso del Event Loop medido con `perf_hooks.monitorEventLoopDelay` (p50/p99/max por instancia) en el tablero. **[MEDIR]** durante el pico.
- Cifras: ingenuo = actas × clientes (6.400 × 400.000 ≈ 2.560 millones). Real (prueba local, 400 clientes, 7.161 envíos): **12.486 mensajes vs 2.425.649 ingenuos (−99,5 %)**. **[MEDIR]** en la nube.

### RF-5 Suscripción por tópico
- Por instancia: `Map<tópico, Set<cliente>>`. Alta y baja O(1); recorrido O(suscriptores del tópico).
- La instancia se suscribe al canal Redis `bp:topic:<t>` solo cuando tiene el primer suscriptor local y se da de baja con el último → el tráfico entre Redis e instancias es proporcional a los tópicos realmente vistos (canal por tópico vs canal global).

### RF-6 Reconexión con continuidad
- Cada actualización se guarda en un **Redis Stream por tópico** (`XADD … MAXLEN ~ 600`) y se publica en Pub/Sub en el **mismo script Lua** → el id que el cliente ve en vivo es el id con el que se reanuda.
- El cliente guarda el último `id` (Stream ID monótono) y reconecta con `lastEventId`.
- El servidor: si el id está dentro del historial y faltan ≤ 300 entradas → `catchup` (las entradas fusionadas en un mensaje); si es más viejo que el historial o faltan más → `snapshot`.
- Pub/Sub no tiene memoria: cuando una instancia recupera la conexión a Redis, resincroniza a todos sus clientes desde el stream.
- Retención: 600 entradas ≈ 20 min por tópico. Memoria medida: ~62 KB por 38 entradas del tópico `dept` (≈1,6 KB/entrada) → 1.873 tópicos × 600 × ~1 KB ≈ **[MEDIR con `MEMORY USAGE`]**; los tópicos de puesto tienen muy pocas entradas.

### RF-7 Cola de verificación con bloqueo exclusivo
- Cola: ZSET con prioridad (mayor descuadre primero, luego el más antiguo).
- Tomar caso (Lua `takeCase`): verifica que esté en la cola y sin bloqueo, crea `SET lock token PX 30000`, lo saca de la cola, registra el dueño. Se publica `taken` y todas las consolas lo reflejan.
- Tensión expiración vs. trabajo largo: el bloqueo dura 30 s y **se renueva con el latido** (cada 10 s) **solo si hubo actividad del auditor en los últimos 5 min**. Si cierra el navegador o pierde la red, no hay latido → expira → el barrido del líder lo devuelve a la cola (`reclaimed`). Si se va a almorzar, el navegador sigue vivo pero sin actividad → no se renueva → vuelve a la cola.
- Liberación segura: el token es único (`auditor:uuid:fencing`). Liberar/resolver/renovar hace `GET lock == token` dentro de Lua; un auditor cuyo bloqueo expiró y fue reasignado recibe `LOCK_LOST` y no puede liberar ni resolver el caso de otro.

### RF-8 Presencia
- ZSET `presence:auditors` (score = último latido) + HASH con detalle (instancia, caso, desde cuándo).
- Latido cada 10 s; TTL 25 s. El coordinador ve solo los que tienen latido reciente; el líder elimina los vencidos. Un portátil sin batería desaparece en ≤ 25 s.

### RF-9 Clientes lentos
- Antes de cada envío se mira `res.writableLength` (SSE) / `ws.bufferedAmount` (WS).
- \> 64 KB: se deja de enviar detalle; cuando el socket drena se envía **una fotografía**.
- \> 512 KB o rezagado más de 30 s: se desconecta; el cliente vuelve con `lastEventId` (continuidad). Demostración: `loadtest/slow-client.js`.

### RF-10 Degradación y avalancha
- **Redis caído**: el cliente Redis no encola comandos (`enableOfflineQueue:false`); el jurado recibe `UNAVAILABLE` con mensaje explícito («NO quedó registrada; se reenviará automáticamente») y el acta sigue en la bandeja local. El público recibe `status: down` y conserva las últimas cifras. Al volver Redis, todo se resincroniza.
- **Avalancha**: el cliente usa backoff exponencial con *full jitter* y respeta `Retry-After`; además cada instancia admite como máximo 400 conexiones nuevas/s (503 + `Retry-After` aleatorio). Gráfica: `loadtest/reconnect-storm.js` genera `storm-comparison.svg`. **[MEDIR]**

## 4. Papel de Redis (sección 5)
| Papel | Estructura |
|---|---|
| Backplane | Pub/Sub, un canal por tópico (`bp:topic:<t>`), `bp:verify`, `bp:jurados` |
| Historial | Stream por tópico, `MAXLEN ~ 600`, ids monótonos |
| Acumulados | HASH por nivel (`tot:<nivel>`) + ZSET de ranking (`rank:<nivel>`) |
| Operación atómica | Script Lua `applyActa` |
| Idempotencia | `SET idem <respuesta> EX 172800` dentro del Lua |
| Bloqueo | `SET lock token PX 30000` + renovación + liberación con verificación de dueño |
| Presencia | ZSET con último latido + HASH de detalle |
| Límite de tasa | `INCR rl:<jurado>:<ventana>` + `EXPIRE`; exceso → `RATE_LIMITED` / HTTP 429 |
| Liderazgo | `SET leader <instancia> PX 6000` renovado por el dueño |

## 5. Sesiones pegajosas prohibidas (RT-2)
Evita: carga desbalanceada y que la caída de una instancia arrastre a "sus" usuarios. Crea: ninguna instancia puede guardar estado del usuario entre peticiones → todo estado compartido está en Redis; un reintento puede caer en otra instancia (por eso idempotencia y tokens viven en Redis); una reconexión SSE cae en cualquier instancia (por eso el historial está en Redis).

## 6. Resultados de las pruebas [MEDIR]
- 20.000 conexiones simultáneas: captura del tablero.
- Retraso del Event Loop p99 por instancia durante el pico.
- Mensajes emitidos vs ingenuo.
- Cliente lento.
- Reconexiones por segundo con y sin jitter.
- INP p75 de la página pública bajo carga.
