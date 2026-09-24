---
name: frontend-implementation
description: Building UI in this repo — Preact + TypeScript + Vite, component structure, state management, styling conventions, responsive behavior, form handling, empty/loading/error states. Use when implementing or updating a frontend page, component, panel or form. Use PROACTIVELY when any change touches `frontend/src` — before writing a component, load the house UI conventions.
---

# Frontend Implementation skill

Scope: Preact components in `frontend/src` that survive review — right-sized, dark-only, consistent with the house patterns. Views live in `frontend/src/views/`, reusable pieces in `frontend/src/components/`, helpers in `frontend/src/lib/`.

## Component structure
- One component per file, default-exported; views are route-level, components are reusable
- Keep components presentational — lift data fetching and mutation to the view or a custom hook (`useChatSocket`, `usePresence`, …)
- Server calls go through `api()` from `src/api.ts`, which attaches the Bearer token and redirects to `/login` on 401 — never `fetch` raw

## House styling conventions
- Dark mode only — never introduce a light theme or hardcoded light colors
- Icons: `lucide-preact` everywhere, rendered as `class="icon"`; spin via `class="icon spin"`
- Destructive/sensitive actions use `ConfirmModal` from components — never `window.confirm`; in-app notices replace `alert()`
- Sudo/sensitive ops use the `ReAuthModal` pattern from components

## State management
- Component-local state via hooks; cross-view state via the `AuthProvider` context in `src/auth.tsx`
- Server-derived state: fetch through the API and cache locally; never mutate shared stores ad hoc
- Token lives in `localStorage['wsd.token']`; settings-like preferences live in `localStorage['wsd.*']` (namespaces deliberately kept)

## Responsive behavior
- Design from the desktop layout down, then verify narrow widths; sidebars and tables get the most breakage
- Long content truncates or wraps — never horizontal overflow on views, terminals and chat are the exception

## Form handling
- Controlled inputs; Enter/Ctrl+Enter conventions where the surrounding view defines them (e.g. quick composers)
- Validate client-side for the same rules the API enforces — cap counters, required fields, numeric ranges
- Never wipe a field the user is typing into because a poll refreshed (the 5s status poll clobbers inputs unless guarded)

## Empty / loading / error states
- Empty: explain what would appear + the action that makes it appear
- Loading: skeleton shimmer or spinner — never a blank screen
- Error: inline message with the server `{error,message}` text; never a silent no-op
- 401s are handled globally by `api()` — only render them inline for intentional verification calls

**Example**
"Add a CPU/RAM limits panel to the project page" → view-local state for input values, `PUT /api/projects/:slug/limits` via `api()`, an honest pending-recreate banner, chips `CPU 2` / `RAM 128Mi` rendered with `fmtCpu`/`fmtMem` from `src/lib/limits.ts`, ConfirmModal on clear.

Every panel you build must look like it was always part of the product, not a new feature bolted on.