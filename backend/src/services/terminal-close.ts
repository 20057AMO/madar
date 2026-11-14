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
 *   4404 container-missing — Docker answered 404 (no such container)   [project mode only]
 *   4409 container-stopped — Docker answered 409 (container exists but is not running) [project mode only]
 *   4503 capacity          — this slug:mode terminal is already open, or the global cap is reached
 *   4500 internal          — anything else that failed to start (retryable)
 * 1008 (project access denied) is produced by ws-server.ts, never here.
 *
 * Two rules that the client's behaviour depends on:
 *  - An EXPLICIT Docker status always wins; the message text is only a fallback
 *    for the status-less case. A 500 whose text merely contains "not found"
 *    (e.g. `exec: "bash": executable file not found in $PATH`) is an internal
 *    failure, never a missing container.
 *  - `4404`/`4409` mean "the PROJECT container `wsd-<slug>` is gone/stopped",
 *    so they exist only in project mode. A control-mode shell lives in the app
 *    container: there is no project container to blame, and the client treats
 *    both codes as permanent (it stops reconnecting), which no control-shell
 *    failure — a broken shell binary, a missing workspace dir, resource
 *    pressure — deserves. Control mode therefore always answers the retryable
 *    4500, and those two codes are unreachable in it.
 */

export const TERMINAL_CLOSE = {
  sessionEnded: 4000,
  containerMissing: 4404,
  containerStopped: 4409,
  capacity: 4503,
  internal: 4500,
} as const;

/** Which shell the socket asked for: `docker exec` into the project container, or a pty in the app container. */
export type TerminalMode = 'project' | 'control';

/** A start failure reduced to what a WebSocket close can carry. */
export interface TerminalStartFailure {
  code: number;
  reason: string;
  message: string;
}

const FALLBACK_MESSAGE = 'Terminal failed to start.';

/** The ellipsis marker is inside this budget: the message is never longer. */
const MAX_MESSAGE_CHARS = 300;

/** Control-mode wording: no project container, no "start the project", and nothing permanent. */
const CONTROL_UNAVAILABLE_MESSAGE = 'Shell is unavailable in the control container. Try again in a moment.';

const MISSING_RE = /no such container|not found/i;
const STOPPED_RE = /is not running|not running|is stopped/i;

/**
 * Map any start/rejection value onto the pinned close contract. Never throws,
 * whatever it is handed (null, a string, a number, a circular object), and
 * never leaks a stack trace into the message the browser will display.
 */
export function mapTerminalStartError(
  err: unknown,
  slug: string,
  mode: TerminalMode = 'project'
): TerminalStartFailure {
  const status = readStatus(err);
  const text = oneLine(readMessage(err));

  // A finite status decides on its own; the text heuristics are fallbacks for
  // the status-less case, so a misleading 500 message can never be reclassified.
  const missing = status === 404 || (status === null && MISSING_RE.test(text));
  const stopped = status === 409 || (status === null && STOPPED_RE.test(text));

  if (mode === 'control') {
    return {
      code: TERMINAL_CLOSE.internal,
      reason: 'terminal-failed',
      message: missing || stopped ? CONTROL_UNAVAILABLE_MESSAGE : text || FALLBACK_MESSAGE,
    };
  }

  if (missing) {
    return {
      code: TERMINAL_CLOSE.containerMissing,
      reason: 'container-missing',
      message: `Project container 'wsd-${slug}' not found. Start the project first.`,
    };
  }

  if (stopped) {
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
