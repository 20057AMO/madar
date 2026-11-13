/**
 * terminal-close.ts
 * Madar — Terminal WebSocket close-code contract (pure, import-free).
 *
 * Import-free on purpose (node --test loads it directly, mirroring
 * serve-core.ts / alerts-core.ts / embed-core.ts): the classification rules are
 * deterministic and must be unit-testable without Docker, ws or Express.
 *
 * Contract (mirrored byte-identically by the frontend):
 *   4000 session-ended     — the shell/pty/exec stream ended (exit, container stopped under the shell)
 *   4404 container-missing — Docker answered 404 (no such container)
 *   4409 container-stopped — Docker answered 409 (container exists but is not running)
 *   4503 capacity          — this slug:mode terminal is already open, or the global cap is reached
 *   4500 internal          — anything else that failed to start (retryable)
 * 1008 (project access denied) is produced by ws-server.ts, never here.
 */

export const TERMINAL_CLOSE = {
  sessionEnded: 4000,
  containerMissing: 4404,
  containerStopped: 4409,
  capacity: 4503,
  internal: 4500,
} as const;

/** A start failure reduced to what a WebSocket close can carry. */
export interface TerminalStartFailure {
  code: number;
  reason: string;
  message: string;
}

const FALLBACK_MESSAGE = 'Terminal failed to start.';

/** The ellipsis marker is inside this budget: the message is never longer. */
const MAX_MESSAGE_CHARS = 300;

const MISSING_RE = /no such container|not found/i;
const STOPPED_RE = /is not running|not running|is stopped/i;

/**
 * Map any start/rejection value onto the pinned close contract. Never throws,
 * whatever it is handed (null, a string, a number, a circular object), and
 * never leaks a stack trace into the message the browser will display.
 */
export function mapTerminalStartError(err: unknown, slug: string): TerminalStartFailure {
  const status = readStatus(err);
  const text = oneLine(readMessage(err));

  if (status === 404 || MISSING_RE.test(text)) {
    return {
      code: TERMINAL_CLOSE.containerMissing,
      reason: 'container-missing',
      message: `Project container 'wsd-${slug}' not found. Start the project first.`,
    };
  }

  if (status === 409 || STOPPED_RE.test(text)) {
    return {
      code: TERMINAL_CLOSE.containerStopped,
      reason: 'container-stopped',
      message: `Project container 'wsd-${slug}' is not running. Start the project, then reconnect.`,
    };
  }

  return {
    code: TERMINAL_CLOSE.internal,
    reason: 'terminal-failed',
    message: text || FALLBACK_MESSAGE,
  };
}

/** Docker errors carry `statusCode`; a proxied/legacy one may carry `status`. */
function readStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const bag = err as { statusCode?: unknown; status?: unknown };
  const raw = bag.statusCode ?? bag.status;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The raw text to classify: an Error's message, a thrown string, a thrown number. */
function readMessage(err: unknown): unknown {
  if (typeof err === 'object' && err !== null) return (err as { message?: unknown }).message;
  if (typeof err === 'function') return undefined;
  return err;
}

/** One line, trimmed, capped — the only shape a close message may take. */
function oneLine(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}
