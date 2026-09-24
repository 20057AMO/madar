---
name: typescript-practices
description: TypeScript conventions — strict typing, discriminated unions, generics, avoiding `any`, type-safe API helpers. Use when writing or reviewing TypeScript. Use PROACTIVELY in any `.ts`/`.tsx` change in this repo — the codebase is strict-mode TS on both sides and the type system carries the API contracts, so load this before reaching for a cast or `any`.
---

# TypeScript Practices skill

Scope: TS that uses the compiler as a design tool. Both `frontend/` (Preact + Vite) and `backend/` (Express 5 + Node 22) are strict-mode TypeScript — `tsc --noEmit` is a gate in the verification pipeline, so the types must actually be airtight, not just present.

## Strict typing
- `tsc --noEmit` green is the entry ticket; never loosen compiler flags to make code pass
- Every module boundary has an explicit type: service functions declare their return contracts, state objects declare their shapes
- Optional fields mean genuinely-optional: `foo?: string` for absent, never `string | undefined` drilled through call sites where a clean optional suffices

## Discriminated unions over flag soup
- Model multi-state data as unions with a literal discriminant: `{ status: 'running' } | { status: 'stopped', exitCode?: number }` — the compiler narrows where the runtime branches
- Exhaustive `switch` on the discriminant; never a stack of `if (x as any)` checks
- This is exactly how crash states, serve states and delegation states are modeled — follow the existing union shapes instead of inventing parallel ones

## Generics
- Generics for containers and helpers that must preserve caller types (typed stores, typed API responses); don't generalize a single concrete use
- Constrain with `extends`; keep the constraint honest — a generic that accepts everything is `any` wearing a hat

## Avoiding `any`
- `any` is a defect in review: it disables the type-checker exactly where the code is most fragile (network payloads, user input)
- Unknown-shaped input (JSON bodies, file content, WS frames) is parsed and narrowed at the boundary: `unknown` → validation/guard → narrow type; the narrow lives next to the parse
- If a library type fights you, wrap it in a small typed adapter rather than casting at every call site

## Type-safe API helpers
- The central `api()` helper in `frontend/src/api.ts` types requests and responses; per-endpoint wrappers return the documented shape, so views never cast raw fetch results
- Backend route inputs are validated (400 before services) and the validated value is typed — the type reflects what passed validation, not what arrived on the wire
- JWT claims, WS messages and audit entries carry typed interfaces matching their JSON shape

**Example**
A WS push `{ type: 'status', payload: {...} }` is parsed from `JSON.parse` → checked by a narrow guard → union-typed frame → exhaustive switch in the hook. The view can never receive an untyped message.

`any` is not a shortcut; it is the delete key for the safety net the whole pipeline assumes is there.