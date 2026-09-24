---
name: documentation
description: Writing technical docs — READMEs, API references, architecture notes, setup guides — matching the existing style of the repo, keeping language clear and claims accurate. Use when creating or updating any doc file. Use PROACTIVELY when a change alters surface behavior (routes, endpoints, steps, flags, conventions) — docs drift the moment a feature lands without one.
---

# Documentation skill

Scope: documentation worth maintaining — accurate, concise, matched to the reader. The standard: a doc that is wrong is worse than no doc, because it is trusted.

## Start with a one-line purpose statement
Every document opens with what it is for and who it serves. Readers decide in one sentence whether to keep reading.

## Match the house style
- Mirror the surrounding docs: heading structure, tone, language, file placement (README.md at root, docs sections in AGENTS.md, per-feature bullets where the project keeps them)
- When the repo writes Arabic user-facing copy, match it; code, commands and identifiers stay English
- Keep the same vocabulary the code uses — a renamed product (WSD-Pro → Madar) must not linger in new docs while legacy names are kept deliberately for infra

## Show, don't tell
- Minimal working examples over prose descriptions; copy-pasteable commands over "run the usual build"
- Document errors and edge cases users will actually hit (429s, self-skip tests, rate-limiter budgets) — not just the happy path
- Put the source of truth in code and link to it; never duplicate entire tables that will drift

## Keep it maintainable
- No exhaustive changelogs inside docs, no duplication of content that will drift — link to the source of truth instead
- Every count you write ("28 agents", "10 endpoints") is a liability: verify it against the tree, and keep it in the fewest places
- If asked to document something that does not exist yet, say so — aspirational docs are the worst kind of drift

## Clarity rules
- One idea per sentence; prefer the shorter word; keep paragraphs under a screen
- Technical claims must match the code — an option that does not exist must not be written down
- For reference material use tables/signatures; for guidance use steps; for rationale use short paragraphs

**Example**
A new endpoint lands → README gains one line (path + one-line purpose, matching the existing bullets), not a full reference; the accurate signature lives in the route file, linked from the doc. Count-check: "8 slash commands" verified against `opencode/command/` before being written.

Documentation is not writing; it is editing reality into a shape others can trust.