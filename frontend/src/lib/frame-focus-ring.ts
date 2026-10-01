/**
 * frame-focus-ring.ts
 * A keyboard user tabbing into the embedded VS Code / opencode surfaces got no
 * visible focus cue at all, and no CSS rule can fix it: Chromium matches
 * NEITHER `:focus`, `:focus-within` NOR `:focus-visible` on a focused <iframe> —
 * the host element is skipped by the parent's style engine once the inner
 * browsing context owns focus. Nor is the transition observable: entering a
 * frame dispatches no `focus`, `focusin` or element-level focus event on it
 * (only `blur`/`focusout` on the control being left), so there is no hook to
 * arm a ring. What does hold is `document.activeElement`: the parent keeps
 * reporting the <iframe> element while its inner document has focus.
 *
 * So the ring is applied imperatively off `document.activeElement`, gated on
 * input modality — a mouse click into a frame focuses it too, and that path
 * must stay ring-free.
 *
 * Reading activeElement once after the keystroke is NOT enough. focus moves in
 * the key's default action, but the switch onto a frame is settled on the
 * browser's own schedule and was measured landing both ~20ms and >1.5s after the
 * keydown, so a single deferred read is a race that intermittently leaves the
 * ring off. The state is therefore RECONCILED until focus comes to rest: while
 * the window is open every tick re-derives the attribute from activeElement,
 * and it closes as soon as the frame is seen focused or the budget runs out.
 * Leaving the frame raises focusin on whatever it lands on next, which closes
 * the ring immediately, so the open window exists only for keyboard focus moves.
 */

const DATA_ATTR = 'data-kbd-focus';

/** Keys that can move focus; only these open a reconcile window. */
const NAV_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  'Escape',
]);

const RECONCILE_MS = 50;
const RECONCILE_BUDGET_MS = 2000;

const rings = new Set<HTMLIFrameElement>();
let keyboard = false;
let wired = false;
let reconcileTimer: ReturnType<typeof setTimeout> | 0 = 0;
let reconcileStart = 0;

function closeReconcile(): void {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = 0;
  }
}

function sync(): void {
  const active = document.activeElement;
  for (const el of rings) {
    if (keyboard && active === el) el.setAttribute(DATA_ATTR, '');
    else el.removeAttribute(DATA_ATTR);
  }
}

function reconcile(): void {
  sync();
  const active = document.activeElement;
  // Focus has come to rest on a frame: the ring is applied, and the way out of
  // it (focusin on the next control) closes it again. Nothing left to watch.
  if (active instanceof HTMLIFrameElement && rings.has(active)) {
    closeReconcile();
    return;
  }
  if (performance.now() - reconcileStart >= RECONCILE_BUDGET_MS) {
    closeReconcile();
    return;
  }
  reconcileTimer = setTimeout(reconcile, RECONCILE_MS);
}

function openReconcile(): void {
  sync();
  if (reconcileTimer) return;
  reconcileStart = performance.now();
  reconcileTimer = setTimeout(reconcile, RECONCILE_MS);
}

function wire(): void {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('keydown', (e) => {
    keyboard = true;
    if (NAV_KEYS.has(e.key)) openReconcile();
    else sync();
  }, true);
  // A click focuses a frame just as a Tab does, so it must clear the ring — and
  // it lands focus on the frame too, so it reconciles for the same reason.
  document.addEventListener('pointerdown', () => {
    keyboard = false;
    openReconcile();
  }, true);
  document.addEventListener('focusin', sync, true);
}

/**
 * Ref callback for an embedded-surface <iframe>; memoise it (useMemo/useCallback)
 * so a re-render does not re-arm every time. Pair it with the
 * `iframe[data-kbd-focus]` rule in index.css — the same --focus-ring token every
 * other control in the app uses.
 */
export function frameFocusRing(): (el: HTMLIFrameElement | null) => void {
  wire();
  let current: HTMLIFrameElement | null = null;
  return (el) => {
    if (current) {
      rings.delete(current);
      current.removeAttribute(DATA_ATTR);
      current = null;
    }
    if (el) {
      rings.add(el);
      current = el;
      sync();
    }
  };
}