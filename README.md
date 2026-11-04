# Preconteo electoral en tiempo real — Taller WebSockets

Sistema de transmisión y difusión de resultados: 8 instancias Node.js sin sesiones pegajosas,
Redis como backplane (Pub/Sub, Streams, Lua, bloqueos, presencia), WebSocket para jurados y
auditores, SSE para el público.

- `backend/`  → servidor, despliegue (Docker Compose + Caddy) y pruebas de carga
- `frontend/` → React + Vite (jurado, público, auditor, coordinador, operación)

Integrantes: Juan David Maya · Cristian · Andrea
Contrato entre front y back: `backend/docs/CONTRATO_API.md`
