import { useEffect, useRef } from "react";

/**
 * Shared loading loop for screens that refresh data at regular intervals.
 *
 * Manually configured `setInterval` patterns had three problems, all addressed
 * by this hook:
 * - the next tick started before the request finished (requests overlapped on slow networks),
 * - in-flight requests were not canceled after unmount,
 * - a late stale response could overwrite the new state.
 *
 * `load` must handle its own errors (showing a message to the user is the
 * caller's responsibility). Canceled requests throw `AbortError`; the caller
 * must filter them with `isAbortError`.
 */
export function usePollingQuery(
  load: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  /**
   * When it changes, the in-flight request is canceled, data reloads immediately,
   * and the timer restarts. This avoids waiting for the next tick after a filter
   * change.
   */
  resetKey?: string,
): void {
  // `load` is recreated on every render; without the ref, the effect would be
  // recreated and the timer reset on every render.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    let stopped = false;

    async function tick(): Promise<void> {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        await loadRef.current(controller.signal);
      } catch (err) {
        // Only errors not caught by the caller reach here; log them instead of
        // silently swallowing them to avoid an unhandled rejection.
        console.error("Polling load failed:", err);
      } finally {
        inFlight = false;
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), intervalMs);

    return () => {
      stopped = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [intervalMs, resetKey]);
}
