import { api } from '../api';
import vaultService from './vaultService';

// Self-service E2EE reset: password-confirmed server-side wipe (devices,
// master key, key packages, DM groups) followed by a local panic wipe and a
// reload. After the reload the normal unlock forms find no vault on either
// side and set up a fresh first-device keystore.
// Throws (without touching local state) when the server rejects the password
// or rate-limits the attempt, so callers can show the error inline.
export async function resetE2ee(password) {
  await api.mls.resetE2ee(password);
  try {
    await vaultService.panicWipe();
  } catch {
    // Server state is already gone; a failed local wipe must not strand the
    // user mid-reset. The reload below re-syncs against the wiped server.
  }
  window.location.reload();
}
