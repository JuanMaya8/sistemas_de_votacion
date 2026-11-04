# Pruebas de carga (RT-8)

Sin dependencias extra (solo Node 20+ y `ws`). Ejecutar desde la carpeta `backend/` después de `npm install`.
Para muchas conexiones: `ulimit -n 65535`. Más de ~25.000 conexiones desde una misma IP → usar 2 o más máquinas (por ejemplo, otra VM de la misma nube).

| Script | Qué demuestra | Ejemplo |
|---|---|---|
| `jornada.js` | Perfil de la jornada: 6.400 actas, 55 % al inicio, reenvíos, correcciones fuera de orden, dudosas. Verifica **convergencia** y reporta mensajes reales vs ingenuos | `node loadtest/jornada.js --url https://DOMINIO --minutes 10` |
| `public-sse.js` | ≥ 20.000 conexiones SSE simultáneas repartidas por tópicos | `node loadtest/public-sse.js --url https://DOMINIO --clients 20000 --workers 4` |
| `slow-client.js` | RF-9: cliente lento → snapshot o desconexión (requiere `DEBUG_ENDPOINTS=1`) | `node loadtest/slow-client.js --url https://DOMINIO` |
| `reconnect-storm.js` | RF-10: reconexiones/s con y sin jitter → `storm-comparison.svg` | `node loadtest/reconnect-storm.js --url https://DOMINIO --clients 5000` |
| `compare-transports.js` | Sección 7: SSE vs WebSocket vs polling | `node loadtest/compare-transports.js --url https://DOMINIO --clients 300` |

Orden sugerido para la sustentación:
1. `npm run reset` (con `REDIS_URL` apuntando al Redis del despliegue, o `docker compose exec app1 node scripts/reset.js`).
2. Abrir el tablero `/#/operacion` del frontend.
3. Terminal A: `public-sse.js --clients 20000`.
4. Terminal B: `jornada.js --minutes 10`.
5. Mientras corre: `docker compose stop app3` (muere una instancia) y observar reconexiones; `docker compose stop redis` 20 s y `start` (modo degradado).
