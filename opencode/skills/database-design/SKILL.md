---
name: database-design
description: Data modeling — schema design, indexes, migrations, data integrity, and JSON-file stores vs SQL trade-offs. Use when designing a data model, store or migration. Use PROACTIVELY when a new persistent artifact is needed in this repo — this platform deliberately uses JSON-file stores with file locks, not a database, so check that decision before reaching for SQL.
---

# Database Design skill

Scope: modeling structured data that stays correct under concurrency, growth and drift — knowing WHEN this repo uses a JSON-file store instead of a database.

## JSON-file stores vs SQL — the house default
This repo persists application state in `data/*.json` files (users, providers, projects meta, chat channels, delegations, webhooks) mode 0600, with `withFileLock('<name>')` per-store sync locks and hard caps (activity 200 entries, notes 300 items, audit 100, webhooks 50, chat 500/channel). Choose this when:
- The read/write pattern is bounded and per-key (a project's own meta, a user's own profile)
- A crash must never corrupt a whole logical database — one file, one lock, atomic rewrite
- The data already lives server-side behind one process

Choose/accept SQL only when a query shape genuinely needs joins, ad-hoc aggregation or open-ended growth that file scans cannot serve — and say so in the ADR.

## Schema design
- Shape documents as immutable-behavior records: `{id, ...payload, createdAt, updatedAt?}` — ids are slugs/UUIDs chosen for their lookup path
- Put discovered reality in the data, not the filename: kinds, roles, flags belong as fields
- Booleans with three states become optional fields — `undefined` = absent/unknown, never a third boolean
- Keep every row ≤ a hard cap (normalize/truncate on write, never on read)

## Indexes (the file-store equivalent)
- The "index" is the id-derived directory/file layout: `data/projects/<slug>/meta.json`, `data/chat-team/<channel>.json`
- Secondary lookups that run hot get a derived lookup file rebuilt on write, not a scan on every read
- Clean up derived artifacts in the same transaction as the record that owns them (delete cascades: project delete removes meta + notes + activity + snapshots + delegations)

## Migrations
- Prefer additive, backward-compatible fields — old rows must read fine with no migration
- Backfill lazily on first read (like the legacy activity feed) so the migration runs exactly once with no boot-time pass
- When a name changes (wsd-pro-backup → madar-backup), accept the legacy form on import and write only the new form going forward
- Normalize on write to the canonical form the rest of the system asserts on (round-trip-stable, like port/limit formats)

## Data integrity
- Every write path validates BEFORE persist: caps, shape, duplicate ids, junk rows (dropped silently on normalize, never crash)
- Traversal-proof joins: any user-supplied id that becomes a path is validated against a strict charset and escaped before `path.join`
- Never trust a stored file you did not write: sanitize rows on load (drop unknown kinds, truncate oversized values)

**Example**
Notes store → `data/projects/<slug>/notes.json`: items `{id, text, kind: 'idea'|'bug'|'goal', done, createdAt}`, cap 300, text ≤2000 chars, junk rows dropped on normalize, unknown kinds default to `idea`. Schema fits a file store — per-project bounded reads, one lock, atomic rewrite.

A store that cannot answer "what corrupts it and how do I recover" is not designed yet.