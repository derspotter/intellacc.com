import { createSignal, onCleanup } from 'solid-js';
import { createConfirmCore, CONFIRM_RESET_MS } from '../../../lib/confirmTimer';

export { CONFIRM_RESET_MS };

/**
 * Solid hook for the shared two-step confirm pattern
 * ("[REVOKE]" → "[CONFIRM?]" → auto-reset after CONFIRM_RESET_MS).
 *
 * const confirmTimer = useConfirmTimer();
 *   confirmTimer.confirm(id)  -> false on the arming click, true on the confirming click
 *   confirmTimer.isArmed(id)  -> reactive; drives the "[CONFIRM?]" label
 *   confirmTimer.disarm(id)   -> onBlur handler: reset if this id is armed
 *
 * The reset timer is cleared via onCleanup, so it can never fire after unmount.
 */
export default function useConfirmTimer(delay = CONFIRM_RESET_MS) {
  const [armedId, setArmedId] = createSignal(null);
  const core = createConfirmCore({ get: armedId, set: setArmedId, delay });
  onCleanup(core.dispose);
  return core;
}
