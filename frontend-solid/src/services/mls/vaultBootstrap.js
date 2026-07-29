// Login-time vault bootstrap, backgrounded and serialized.
//
// Every login path used to AWAIT the whole vault sequence (master-key fetch,
// deliberately-slow PBKDF2, and on first devices: device registration, OpenMLS
// init, key package uploads) before navigating — 2-5s of "Redirecting…" on
// first logins. This helper runs that sequence detached so navigation happens
// immediately, while guarding the hazards of doing so:
//
// - Serialization: setupKeystoreWithPassword mutates the vaultService
//   singleton and drives the server's first-device TOFU bootstrap, which must
//   run at most once. One in-flight promise per user; concurrent starts join
//   it, and the manual unlock forms (MessagesPage, ChatPanel) join it too
//   instead of racing their own setup.
// - Stale-awareness: if the user logs out (or into another account) while the
//   bootstrap is still running, the completion path must not touch UI state.
// - LINK_REQUIRED: surfaced by flagging the DeviceLinkModal in the store; the
//   modal is mounted on the messaging surfaces, so it appears when the user
//   gets there — the unlock banner covers the retry with a fresh password.
//
// The password lives only in this module's async closure and is dropped when
// the promise settles — same exposure as the old awaited code.

let inflight = null;
let inflightKey = null;

const isLinkRequiredError = (err) =>
  err && err.status === 403 && err.data?.code === 'LINK_REQUIRED';

export function startVaultLoginBootstrap(userId, password) {
  const key = String(userId ?? '');
  if (!key || !password) return null;
  if (inflight && inflightKey === key) return inflight;

  inflightKey = key;
  inflight = (async () => {
    const { default: vaultStore } = await import('../../store/vaultStore.js');
    const { default: vaultService } = await import('./vaultService.js');

    vaultStore.setBootstrapping(true);
    try {
      vaultStore.setUserId(userId);
      vaultService.setUserId?.(userId);
      const unlocked = await vaultService.findAndUnlock(password, key);
      if (!unlocked) {
        await vaultService.setupKeystoreWithPassword(password);
      }
    } catch (err) {
      const { getCurrentUserId } = await import('../auth.js');
      const { userData } = await import('../tokenService.js');
      const current = getCurrentUserId();
      const username = userData()?.username;
      const stillSameUser =
        String(current ?? '') === key || String(username ?? '') === key;
      if (stillSameUser) {
        if (isLinkRequiredError(err)) {
          vaultStore.setShowDeviceLinkModal(true);
        } else {
          console.warn('[VaultBootstrap] unlock/setup failed:', err?.message || err);
        }
      }
    } finally {
      vaultStore.setBootstrapping(false);
      inflight = null;
      inflightKey = null;
    }
  })();
  return inflight;
}

// The in-flight login bootstrap, or null. Manual unlock paths await this
// (errors already handled inside) and re-check isLocked before starting
// their own unlock/setup.
export function joinVaultBootstrap() {
  return inflight;
}
