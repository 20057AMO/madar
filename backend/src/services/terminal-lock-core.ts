/**
 * terminal-lock-core.ts
 * Madar — Terminal session reservation registry (pure, import-free).
 *
 * Import-free on purpose (node --test loads it directly, mirroring
 * serve-core.ts / terminal-close.ts / alerts-core.ts): no ws, no dockerode, no
 * fs, no timers — just two Maps and synchronous decisions, so the slot rules are
 * deterministically unit-testable without a container.
 *
 * WHY THIS EXISTS (the race it closes): ws-terminal.ts used to keep an advisory
 * `Set<string>` of `slug:mode` keys and fill it from a promise callback —
 * `has()` ran before the spawn, `add()` ran only after the shell had started
 * (seconds later for a `docker exec`). Two concurrent connections to the same
 * project terminal therefore both passed the check and BOTH spawned a shell.
 * A check followed by a write across a tick is not a lock.
 *
 * The registry decides and writes in ONE synchronous call: `reserve()` has no
 * `await`, no promise and no callback inside it, so the check-then-set window
 * is structurally impossible. Keep it that way — never wrap a `reserve()` in an
 * async step, and never `release()` on another session's behalf.
 *
 * Contract:
 *  - The contention key is `slug:mode`, SYSTEM-WIDE (not per user): the
 *    documented behaviour "a slug:mode terminal is already open" is preserved,
 *    so a second user on the same project terminal is refused with `busy`.
 *  - `busy` beats `capacity`: an occupied pair is reported as busy even when the
 *    global cap is reached too, because closing an existing terminal is the
 *    action that helps, where "too many" would be misleading.
 *  - A reservation carries the owning `userId` (honest messaging + a future
 *    per-user policy seam; deliberately NOT part of the key) and a unique
 *    `token` — the ownership proof `release()` checks. A socket can only free
 *    its own slot: a foreign, stale or empty token is a no-op returning false.
 *  - No TTL and no cleanup timer, by design. A slot is freed by its owner's
 *    close path only (socket close, start failure, or a spawn that lands on an
 *    already-closed socket). An expiry here would let a long-running shell be
 *    reaped out from under its owner while the socket is still live — do not
 *    add one.
 */

export const TERMINAL_MAX_SESSIONS = 16;

export type TerminalMode = 'project' | 'control';

export interface TerminalReservation {
  slug: string;
  mode: TerminalMode;
  userId: string;
  token: string;
  at: number;
}

export interface ReserveInput {
  slug: string;
  mode: TerminalMode;
  userId: string;
}

export type ReserveResult =
  | { ok: true; reservation: TerminalReservation }
  | { ok: false; reason: 'busy' | 'capacity' };

export interface TerminalSlots {
  /** Synchronous by contract: decide and write in one tick. Token is injectable for tests. */
  reserve(input: ReserveInput, token?: string): ReserveResult;
  /** True only when it removed the reservation that owns this token. */
  release(token: string): boolean;
  slotOf(slug: string, mode: TerminalMode): TerminalReservation | undefined;
  size(): number;
  clear(): void;
}

export interface TerminalSlotsOptions {
  max?: number;
  now?: () => number;
  tokenFactory?: () => string;
}

/**
 * `slug:mode` — the one contention key. The slug is already canonicalized
 * upstream (`canonicalProjectSlug`), so this is a plain join and never a fold.
 */
function slotKey(slug: string, mode: TerminalMode): string {
  return `${slug}:${mode}`;
}

/**
 * A unique-enough ownership token without importing node:crypto (this module
 * must stay import-free). `globalThis.crypto` is the Web Crypto global on
 * Node 19+, so `randomUUID` is available without a require.
 */
function defaultToken(): string {
  const webcrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webcrypto && typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createTerminalSlots(options: TerminalSlotsOptions = {}): TerminalSlots {
  const rawMax = Number(options.max);
  const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : TERMINAL_MAX_SESSIONS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const tokenFactory = typeof options.tokenFactory === 'function' ? options.tokenFactory : defaultToken;

  /** key (`slug:mode`) → reservation. */
  const slots = new Map<string, TerminalReservation>();
  /** token → key, so release is an ownership check and never a scan. */
  const byToken = new Map<string, string>();

  return {
    reserve(input, token) {
      const key = slotKey(input.slug, input.mode);
      // Order matters: busy first (closing a terminal is the fix), capacity second.
      if (slots.has(key)) return { ok: false, reason: 'busy' };
      if (slots.size >= max) return { ok: false, reason: 'capacity' };

      let candidate = typeof token === 'string' && token.length > 0 ? token : tokenFactory();
      // An injected token is only an ownership proof while it is unique; if it
      // is already live, fall back to the factory instead of aliasing two slots.
      let guard = 0;
      while (byToken.has(candidate) && guard < 8) {
        candidate = tokenFactory();
        guard += 1;
      }

      const reservation: TerminalReservation = {
        slug: input.slug,
        mode: input.mode,
        userId: input.userId,
        token: candidate,
        at: now(),
      };
      slots.set(key, reservation);
      byToken.set(candidate, key);
      return { ok: true, reservation };
    },

    release(token) {
      if (typeof token !== 'string' || token.length === 0) return false;
      const key = byToken.get(token);
      if (key === undefined) return false;
      if (slots.get(key)?.token !== token) return false;
      byToken.delete(token);
      slots.delete(key);
      return true;
    },

    slotOf(slug, mode) {
      const found = slots.get(slotKey(slug, mode));
      return found ? { ...found } : undefined;
    },

    size() {
      return slots.size;
    },

    clear() {
      slots.clear();
      byToken.clear();
    },
  };
}
