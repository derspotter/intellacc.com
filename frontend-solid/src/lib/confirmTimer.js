// Two-step confirm state with auto-reset ("click once → CONFIRM? → reverts
// after CONFIRM_RESET_MS"). Pure core: state access and timers are injected so
// the logic is unit-testable without Solid. The Solid-facing wrapper lives in
// components/terminal/lib/useConfirmTimer.js.

export const CONFIRM_RESET_MS = 4000;

/**
 * @param {object} opts
 * @param {() => any} opts.get        read the currently armed id (null = none)
 * @param {(v: any) => void} opts.set signal-style setter (accepts value or updater fn)
 * @param {(fn: () => void, ms: number) => any} [opts.schedule]
 * @param {(timer: any) => void} [opts.cancel]
 * @param {number} [opts.delay]
 */
export function createConfirmCore({
  get,
  set,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (t) => clearTimeout(t),
  delay = CONFIRM_RESET_MS
}) {
  let timer = null;

  const stop = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  const reset = () => {
    stop();
    set(null);
  };

  return {
    /** True while `id` is awaiting its second (confirming) click. */
    isArmed: (id) => get() === id,

    /**
     * First call for an id arms it and returns false (render "[CONFIRM?]").
     * A second call while armed disarms and returns true (perform the action).
     * Arming a different id replaces the previous one.
     */
    confirm(id) {
      if (get() !== id) {
        stop();
        set(id);
        timer = schedule(() => {
          timer = null;
          set((cur) => (cur === id ? null : cur));
        }, delay);
        return false;
      }
      reset();
      return true;
    },

    /** Disarm only if `id` is the armed one (e.g. onBlur of its button). */
    disarm(id) {
      if (get() === id) reset();
    },

    /** Cancel any pending timer without touching state (unmount cleanup). */
    dispose: stop
  };
}
