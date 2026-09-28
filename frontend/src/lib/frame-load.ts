import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/**
 * frame-load.ts
 * Shared frame-load state machine for the embedded tool pages (VS Code +
 * opencode). Both tools are supervised child processes of the app container, so
 * one can vanish for a few seconds after an update and the iframe's `load`
 * event never arrives. A boolean "ready" flag turns that into a permanent
 * spinner, so the frame is modelled as a tri-state and every mount is armed
 * with a cancellable timeout that ends in an actionable error state.
 */

/** Retry/recovery budget: the tool is already known to be running. */
export const FRAME_LOAD_TIMEOUT_MS = 15000;
/** First-visit budget: a cold code-server / opencode start is much slower. */
export const FRAME_LOAD_TIMEOUT_FIRST_MS = 30000;

export type FrameState = 'loading' | 'ready' | 'error';

export interface FrameLoad {
  /** Key for the iframe element — bumping it remounts and re-arms the frame. */
  frameKey: number;
  state: FrameState;
  onLoad: () => void;
  /** Remount the frame (retry / process-recovery), re-arming the timeout. */
  remount: () => void;
  /** Non-reactive read, safe to use inside effects without re-subscribing. */
  isReady: () => boolean;
}

/**
 * `url` is part of the machine's identity, not just `frameKey`: the reported
 * port arrives from the status poll and can change the frame's destination
 * without a remount, and a frame that hangs on a stale URL must still be armed.
 */
export function useFrameLoad(active: boolean, url: string): FrameLoad {
  const [frameKey, setFrameKey] = useState(0);
  const [state, setState] = useState<FrameState>('loading');
  const stateRef = useRef<FrameState>('loading');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the very first arming of a visit gets the long budget: a cold
  // code-server / opencode start routinely needs >15s, while a Retry click or an
  // automatic post-outage recovery is a known-running process and a stalling
  // frame there is a real failure worth surfacing quickly. The flag is consumed
  // on the first *active* arming, so an inactive mount never burns the budget.
  const firstArmRef = useRef(true);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!active) return;
    const budget = firstArmRef.current ? FRAME_LOAD_TIMEOUT_FIRST_MS : FRAME_LOAD_TIMEOUT_MS;
    firstArmRef.current = false;
    stateRef.current = 'loading';
    setState('loading');
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      stateRef.current = 'error';
      setState('error');
    }, budget);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [frameKey, active, url]);

  const onLoad = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    stateRef.current = 'ready';
    setState('ready');
  }, []);

  const remount = useCallback(() => setFrameKey((k) => k + 1), []);

  const isReady = useCallback(() => stateRef.current === 'ready', []);

  return { frameKey, state, onLoad, remount, isReady };
}

/**
 * Keep keyboard focus alive across a remount. The Retry button that triggers a
 * remount is unmounted with the frame (the state flips back to 'loading'), so
 * focus silently falls back to <body> and a keyboard user is dumped at the top
 * of the document. Attach the returned ref to the loading overlay (which needs
 * tabIndex={-1}) and focus returns there.
 *
 * Deliberately narrow, so it can never steal focus in a loop:
 *   - only on a *transition* back into 'loading' (an initial mount starts in
 *     'loading' already and is left alone),
 *   - only while focus has already been lost (activeElement === body),
 *   - after a frame, and the effect re-runs only when the state changes.
 */
export function useFrameFocusReturn(state: FrameState) {
  const ref = useRef<HTMLDivElement>(null);
  const prevRef = useRef<FrameState>(state);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = state;
    if (state !== 'loading') return;
    if (prev !== 'ready' && prev !== 'error') return;
    if (typeof document === 'undefined' || document.activeElement !== document.body) return;
    const raf = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [state]);

  return ref;
}
