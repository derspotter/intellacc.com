import {
  createSignal,
  onMount,
  Show
} from 'solid-js';
import { configureIdleAutoLock, loadIdleLockConfig } from '../../services/idleLock';
import { api } from '../../services/api';
import vaultStore from '../../store/vaultStore';
import vaultService from '../../services/mls/vaultService';

export default function VaultSettings() {
  const [showChangePassword, setShowChangePassword] = createSignal(false);

  const [currentPassword, setCurrentPassword] = createSignal('');
  const [newPassword, setNewPassword] = createSignal('');
  const [confirmPassword, setConfirmPassword] = createSignal('');
  const [passwordChangeError, setPasswordChangeError] = createSignal('');
  const [passwordChangeSuccess, setPasswordChangeSuccess] = createSignal('');
  const [isChanging, setIsChanging] = createSignal(false);

  const [unlockPassword, setUnlockPassword] = createSignal('');
  const [unlockError, setUnlockError] = createSignal('');
  const [isUnlocking, setIsUnlocking] = createSignal(false);

  const requiresVaultSetup = () => !vaultStore.vaultExists;
  const isLocked = () => vaultStore.isLocked;

  onMount(() => {
    loadIdleLockConfig();
  });

  const handleAutoLockChange = (event) => {
    const minutes = parseInt(event.target.value, 10);
    configureIdleAutoLock(minutes);
  };

  const handleLockNow = async () => {
    await vaultService.lockKeys();
    window.location.hash = 'login';
  };

  const handleUnlock = async (event) => {
    event.preventDefault();
    setIsUnlocking(true);
    setUnlockError('');
    try {
      await vaultService.unlockWithPassword(unlockPassword());
      setUnlockPassword('');
    } catch (err) {
      setUnlockError(err?.message || 'Incorrect password');
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleChangePassword = async (event) => {
    event.preventDefault();
    setPasswordChangeError('');
    setPasswordChangeSuccess('');

    if (!currentPassword() || !newPassword() || !confirmPassword()) {
      setPasswordChangeError('All fields are required.');
      return;
    }

    if (newPassword() !== confirmPassword()) {
      setPasswordChangeError('New passwords do not match.');
      return;
    }

    if (newPassword().length < 6) {
      setPasswordChangeError('Password must be at least 6 characters.');
      return;
    }

    setIsChanging(true);
    try {
      await vaultService.changePassphrase(currentPassword(), newPassword());
      await api.users.changePassword(currentPassword(), newPassword());
      setPasswordChangeSuccess('Password changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      setTimeout(() => {
        setShowChangePassword(false);
        setPasswordChangeSuccess('');
      }, 2000);
    } catch (err) {
      setPasswordChangeError(err?.message || 'Failed to change password.');
    } finally {
      setIsChanging(false);
    }
  };

  const handlePanicWipe = async () => {
    const confirmed = window.confirm(
      'WARNING: This will permanently delete all your encrypted messages and cryptographic keys.\n\n'
      + 'This action cannot be undone.'
    );
    if (!confirmed) {
      return;
    }

    const double = window.confirm(
      'This will permanently erase encrypted vault data and messages. Type OK to continue.'
    );
    if (!double) {
      return;
    }

    const doWipe = async () => {
      if (typeof vaultService.panicWipe === 'function') {
        await vaultService.panicWipe();
      } else {
        await vaultService.lockKeys();
      }
      window.location.href = '/#login';
    };

    try {
      await doWipe();
    } catch (err) {
      window.alert(err?.message || 'Failed to wipe local vault data.');
    }
  };

  return (
    <section class="settings-section vault-settings">
      <h3 class="settings-section-title">
        <span class="section-icon">🔐</span>
        Encryption Vault &amp; Security
      </h3>

      <Show when={requiresVaultSetup()}>
        <div class="vault-not-setup">
          <p>Your vault has not been set up yet. Log in again to initialize it automatically.</p>
        </div>
      </Show>

      <Show when={!requiresVaultSetup()}>
        <div class="vault-settings-content">
          <div class="vault-status">
            <span class={`status-indicator ${isLocked() ? 'locked' : 'unlocked'}`} />
            <span class="status-text">
              {isLocked() ? 'Vault is locked' : 'Vault is unlocked'}
            </span>
          </div>

          <Show when={isLocked()}>
            <div class="unlock-form-container">
              <p>Enter your password to unlock the vault and access encrypted messages.</p>
              <form class="settings-form" onSubmit={handleUnlock}>
                <div class="form-group">
                  <input
                    type="password"
                    class="form-input"
                    placeholder="Password"
                    value={unlockPassword()}
                    onInput={(event) => setUnlockPassword(event.target.value)}
                    disabled={isUnlocking()}
                  />
                </div>
                <button type="submit" class="button button-primary" disabled={isUnlocking()}>
                  {isUnlocking() ? 'Unlocking…' : 'Unlock Vault'}
                </button>
              </form>
              <Show when={unlockError()}>
                <p class="error-message">{unlockError()}</p>
              </Show>
            </div>
          </Show>

          <Show when={!isLocked()}>
            <div class="setting-item">
              <label for="auto-lock-select">Auto-lock after inactivity</label>
              <select
                id="auto-lock-select"
                value={String(vaultStore.autoLockMinutes)}
                onChange={handleAutoLockChange}
              >
                <option value="0">Never</option>
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
              </select>
            </div>

            <div class="setting-item">
              <button
                type="button"
                class="button button-secondary"
                onClick={() => setShowChangePassword((current) => !current)}
              >
                {showChangePassword() ? 'Cancel Password Change' : 'Change Account Password'}
              </button>
            </div>

            <Show when={showChangePassword()}>
              <form class="settings-form" onSubmit={handleChangePassword}>
                <div class="form-group">
                  <label>Current Password</label>
                  <input
                    type="password"
                    class="form-input"
                    value={currentPassword()}
                    onInput={(event) => setCurrentPassword(event.target.value)}
                    required
                    disabled={isChanging()}
                  />
                </div>
                <div class="form-group">
                  <label>New Password</label>
                  <input
                    type="password"
                    class="form-input"
                    value={newPassword()}
                    onInput={(event) => setNewPassword(event.target.value)}
                    required
                    minLength="6"
                    disabled={isChanging()}
                  />
                </div>
                <div class="form-group">
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    class="form-input"
                    value={confirmPassword()}
                    onInput={(event) => setConfirmPassword(event.target.value)}
                    required
                    disabled={isChanging()}
                  />
                </div>
                <div class="form-actions">
                  <button type="submit" class="button button-primary" disabled={isChanging()}>
                    {isChanging() ? 'Changing…' : 'Update Password'}
                  </button>
                </div>
                <Show when={passwordChangeError()}>
                  <p class="error-message">{passwordChangeError()}</p>
                </Show>
                <Show when={passwordChangeSuccess()}>
                  <p class="success-message">{passwordChangeSuccess()}</p>
                </Show>
              </form>
            </Show>

            <div class="setting-item">
              <button type="button" class="button button-secondary" onClick={handleLockNow}>
                Lock Now
              </button>
            </div>
          </Show>

          <div class="danger-zone">
            <h3>Danger Zone</h3>
            <p>Delete local vault data. This cannot be undone.</p>
            <button type="button" class="button button-danger" onClick={handlePanicWipe}>
              Emergency Wipe Vault
            </button>
          </div>
        </div>
      </Show>
    </section>
  );
}
