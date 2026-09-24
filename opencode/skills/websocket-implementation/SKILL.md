---
name: websocket-implementation
description: WebSocket endpoints — auth via token, room management, reconnection, HTTP polling fallbacks, connection caps. Use when implementing or modifying a WS endpoint or its client hook. Use PROACTIVELY when a real-time surface is added (status, logs, terminal, chat) — every house WS endpoint follows the same auth/fallback/cap contract, so load this before hand-rolling a socket.
---

# WebSocket Implementation skill

Scope: the `/ws/*` surface in `backend/src/ws/` + the client hooks that consume it. Real-time is a contract, not a feature: auth first, fallback always, caps enforced.

## Auth via token
- The JWT is passed on upgrade as `?token=` and validated server-side — never cookies, never query-path leakage in logs
- Close unknown/invalid tokens before replaying anything; project-bound rooms check membership the same way the HTTP route does (outsiders closed 1008)
- Scoped tokens (providers-unlock, 2fa-pending) and stale `tv` versions must NEVER authenticate a socket

## Room management
- Room = a broadcast unit (project slug, chat id, agent id); one handler owns membership per room
- Write permission is checked per-ACTION, not per-connection: a viewer member stays connected and gets an explicit read-only `error` frame rather than a silent drop
- Global rooms (status feed) stay open to every authenticated user; per-project rooms mirror `requireProjectAccess`

## Connection caps and heartbeat
- Hard cap per WS room (house standard: 8) — the server refuses or evicts beyond it rather than degrading
- Track rooms per connection and remove the connection on `close` — a leaked membership is a memory leak and a zombie listener
- Heartbeat/idle policies must be explicit; a dead peer is cleaned up aggressively

## Reconnection and HTTP polling fallbacks
- Every WS client needs a degraded-mode story: project status/logs hooks try WS first and fall back to 5s polling; chat/agent use exponential-backoff reconnect (2s → 16s)
- The fallback must serve the SAME data shape the WS pushes — the UI should not branch on transport
- Server pushes carry enough state to rebuild the full view from one message, so a reconnect does not need history replay to be correct

## Client hook conventions
- Custom hooks own the socket lifecycle (`useChatSocket`, `useTeamChatSocket`, `usePresence`): connect, subscribe/unsubscribe, cleanup on unmount
- Deliver events to the view as typed messages; never let the view touch the raw socket

**Example**
Project status → `/ws/projects/status` broadcasts all changes globally; per-project `/ws/projects/:slug/status` polls Docker stats every 3s server-side and pushes them. The client hook subscribes, polls as fallback, events typed — a new contributor reimplements this instead of replicating the pattern.

A socket with no fallback is a feature that works only while the network does.