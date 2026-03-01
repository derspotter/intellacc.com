import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount
} from 'solid-js';
import { api } from '../../services/api';
import vaultService from '../../services/mls/vaultService';
import vaultStore from '../../store/vaultStore';

const formatDate = (value) => {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString();
};

export default function DeviceManager() {
  const [devices, setDevices] = createSignal([]);
  const [isLoading, setIsLoading] = createSignal(true);
  const [pendingRequests, setPendingRequests] = createSignal([]);
  const [pendingLoading, setPendingLoading] = createSignal(true);

  const [linkToken, setLinkToken] = createSignal(null);
  const [isPolling, setIsPolling] = createSignal(false);
  const [approveToken, setApproveToken] = createSignal('');
  const [isApproving, setIsApproving] = createSignal(false);
  const [approveError, setApproveError] = createSignal('');
  const [approverPassword, setApproverPassword] = createSignal('');
  const [unlockPassword, setUnlockPassword] = createSignal('');
  const [unlocking, setUnlocking] = createSignal(false);
  const [unlockError, setUnlockError] = createSignal('');
  const [intervalId, setIntervalId] = createSignal(null);

  const requiresVaultAuth = () => vaultStore.isLocked || !vaultStore.vaultExists;

  const loadDevices = async () => {
    try {
      const rows = await api.devices.list();
      setDevices(rows || []);
    } catch (error) {
      console.error('[DeviceManager] Failed to load devices:', error);
      setDevices([]);
    } finally {
      setIsLoading(false);
    }
  };

  const loadPending = async () => {
    try {
      setPendingRequests(await api.devices.listPendingLinkRequests());
      setPendingLoading(false);
    } catch (error) {
      setPendingRequests([]);
      setPendingLoading(false);
      console.warn('[DeviceManager] Failed to load pending requests:', error);
    }
  };

  const pollPending = async () => {
    if (!isPolling()) {
      return;
    }

    try {
      const link = linkToken();
      if (!link) return;

      const status = await api.devices.getLinkingStatus(link);
      if (status?.approved) {
        setIsPolling(false);
        setLinkToken(null);
        setIntervalId((current) => {
          if (current) {
            clearInterval(current);
          }
          return null;
        });
        window.alert('Device linked successfully.');
        void loadDevices();
      }
    } catch (error) {
      console.error('[DeviceManager] Polling status failed:', error);
    }
  };

  const startPolling = () => {
    if (intervalId()) {
      return;
    }

    setIsPolling(true);
    pollPending();
    const id = window.setInterval(() => {
      void pollPending();
    }, 3000);
    setIntervalId(id);
  };

  const stopPolling = () => {
    const id = intervalId();
    if (id) {
      clearInterval(id);
    }
    setIntervalId(null);
    setIsPolling(false);
  };

  const handleUnlock = async (event) => {
    event.preventDefault();
    setUnlocking(true);
    setUnlockError('');

    try {
      await vaultService.unlockWithPassword(unlockPassword());
      setUnlockPassword('');
    } catch (err) {
      setUnlockError('Incorrect password');
    } finally {
      setUnlocking(false);
    }
  };

  const handleRevoke = async (deviceId) => {
    if (!window.confirm('Revoke this device? It will stop receiving end-to-end encrypted messages.')) return;
    try {
      await api.devices.revoke(deviceId);
      await loadDevices();
    } catch (err) {
      window.alert('Failed to revoke device');
    }
  };

  const startLinking = async () => {
    if (requiresVaultAuth()) {
      window.alert('Unlock vault first to start linking another device.');
      return;
    }

    try {
      const deviceId = vaultService.getDeviceId();
      const name = `${navigator.platform || 'Web'} - ${navigator.userAgent.split('/')[0]}`;
      const result = await api.devices.startLinking(deviceId, name);
      setLinkToken(result?.token || null);
      startPolling();
      await loadPending();
    } catch (err) {
      window.alert('Failed to start linking flow.');
    }
  };

  const handleApprove = async () => {
    const token = approveToken().trim();
    if (!token) {
      setApproveError('Enter a token to approve.');
      return;
    }
    if (!approverPassword().trim()) {
      setApproveError('Approver password is required.');
      return;
    }

    setIsApproving(true);
    setApproveError('');

    try {
      await api.devices.approveLinking(token, approverPassword());
      setApproveToken('');
      setApproverPassword('');

      await loadDevices();
      await loadPending();
      window.alert('Device approved.');
    } catch (err) {
      setApproveError(err?.message || 'Approval failed');
    } finally {
      setIsApproving(false);
    }
  };

  onMount(() => {
    void loadDevices();
    void loadPending();
    const poll = window.setInterval(() => {
      void loadPending();
    }, 15000);

    onCleanup(() => {
      clearInterval(poll);
      stopPolling();
    });
  });

  return (
    <section class="settings-section device-manager">
      <h3 class="settings-section-title">
        <span class="section-icon">📱</span>
        Linked Devices
      </h3>

      <div class="device-content">
        <p>Devices trusted to access your encrypted messages.</p>

        <Show when={isLoading()}>
          <p>Loading…</p>
        </Show>

        <Show when={!isLoading()}>
          <ul class="device-list">
            <Show when={devices().length === 0}>
              <li class="device-item">
                <span>No devices yet.</span>
              </li>
            </Show>

            <For each={devices()}>
              {(device) => (
                <li class="device-item">
                  <div class="device-info">
                    <span class="device-name">
                      {(device.name || 'Unknown Device')}
                      {device.is_primary ? <span class="badge primary"> Primary</span> : null}
                      {vaultService.getDeviceId && vaultService.getDeviceId() === device.device_public_id ? <span class="badge current"> This Device</span> : null}
                    </span>
                    <span class="device-details">Added: {formatDate(device.created_at)}</span>
                  </div>
                  <Show when={!(device.is_primary || vaultService.getDeviceId() === device.device_public_id)}>
                    <button
                      type="button"
                      class="button button-danger button-sm"
                      onClick={() => handleRevoke(device.id)}
                    >
                      Revoke
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-color);">
          <Show when={requiresVaultAuth()}>
            <div class="unlock-form-container">
              <p>Unlock your vault to manage linked devices.</p>
              <form class="settings-form" onSubmit={handleUnlock}>
                <input
                  type="password"
                  class="form-input"
                  placeholder="Password"
                  value={unlockPassword()}
                  onInput={(event) => setUnlockPassword(event.target.value)}
                  required
                />
                <button type="submit" class="button button-primary" disabled={unlocking()}>
                  {unlocking() ? 'Unlocking…' : 'Unlock Vault'}
                </button>
              </form>
              <Show when={unlockError()}>
                <p class="error-message">{unlockError()}</p>
              </Show>
            </div>
          </Show>

          <Show when={!requiresVaultAuth()}>
            <div class="linking-actions">
              <h4>Pending Link Requests</h4>
              <Show when={pendingLoading()}>
                <p>Checking for pending requests…</p>
              </Show>
              <Show when={!pendingLoading()}>
                <Show when={pendingRequests().length === 0}>
                  <p>No pending link requests.</p>
                </Show>

                <For each={pendingRequests()}>
                  {(request) => (
                    <li class="device-item">
                      <div class="device-info">
                        <span class="device-name">{request.device_name || 'New Device'}</span>
                        <span class="device-details">Device: {request.device_public_id}</span>
                        <span class="device-details">
                          Expires: {formatDate(request.expires_at)}
                        </span>
                      </div>
                    </li>
                  )}
                </For>
              </Show>

              <div style="margin-top: 1rem;">
                <button type="button" class="button button-secondary" onClick={startLinking}>
                  Link Another Device
                </button>
              </div>

              <Show when={isPolling()}>
                <p>Waiting for approval on new device…</p>
              </Show>

              <Show when={linkToken()}>
                <div style={{ marginTop: '0.6rem' }}>
                  <p>Approval token issued. Waiting for remote login to submit it.</p>
                </div>
              </Show>

              <div style="margin-top: 1rem;">
                <p style="margin-bottom: 0.4rem;">Approve link from full token:</p>
                <div class="linking-approve-row">
                  <input
                    type="text"
                    class="form-input"
                    placeholder="Enter linking token"
                    value={approveToken()}
                    onInput={(event) => setApproveToken(event.target.value)}
                  />
                  <input
                    type="password"
                    class="form-input"
                    placeholder="Approver password"
                    value={approverPassword()}
                    onInput={(event) => setApproverPassword(event.target.value)}
                  />
                  <button
                    type="button"
                    class="button button-secondary"
                    onClick={handleApprove}
                    disabled={isApproving()}
                  >
                    {isApproving() ? 'Approving…' : 'Approve'}
                  </button>
                </div>
              </div>
              <Show when={approveError()}>
                <p class="error-message">{approveError()}</p>
              </Show>

              <div style="margin-top: 1rem;">
                <button
                  type="button"
                  class="button button-secondary button-sm"
                  onClick={() => {
                    setIsPolling(false);
                    setLinkToken(null);
                    stopPolling();
                  }}
                  disabled={!isPolling()}
                >
                  Cancel Pending Approval
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </section>
  );
}
