import { For, Show, createSignal, onMount, onCleanup } from 'solid-js';
import { api } from '../../../../services/api';
import vaultService from '../../../../services/mls/vaultService';
import vaultStore from '../../../../store/vaultStore';
import useConfirmTimer from '../../lib/useConfirmTimer';

export default function DevicesSection() {
  const [devices, setDevices] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [pending, setPending] = createSignal([]);
  const [pendingLoading, setPendingLoading] = createSignal(true);
  const [error, setError] = createSignal('');

  const [linkToken, setLinkToken] = createSignal(null);
  const [polling, setPolling] = createSignal(false);
  const [linkError, setLinkError] = createSignal('');

  const [approveToken, setApproveToken] = createSignal('');
  const [approverPassword, setApproverPassword] = createSignal('');
  const [approving, setApproving] = createSignal(false);
  const [approveError, setApproveError] = createSignal('');
  const [approveMessage, setApproveMessage] = createSignal('');

  const confirmTimer = useConfirmTimer();
  let pollTimer;
  let pendingTimer;

  const requiresVaultAuth = () => vaultStore.isLocked || !vaultStore.vaultExists;

  const loadDevices = async () => {
    try {
      const rows = await api.devices.list();
      setDevices(rows || []);
    } catch (e) {
      setDevices([]);
    } finally {
      setLoading(false);
    }
  };

  const loadPending = async () => {
    try {
      setPending(await api.devices.listPendingLinkRequests());
    } catch (e) {
      setPending([]);
    } finally {
      setPendingLoading(false);
    }
  };

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    setPolling(false);
  };

  const pollLinkStatus = async () => {
    const token = linkToken();
    if (!token) return;
    try {
      const status = await api.devices.getLinkingStatus(token);
      if (status?.approved) {
        stopPolling();
        setLinkToken(null);
        await loadDevices();
        await loadPending();
      }
    } catch (e) { /* keep polling */ }
  };

  const startLinking = async () => {
    if (pollTimer) return;
    setLinkError('');
    try {
      const deviceId = vaultService.getDeviceId();
      const name = `${navigator.platform || 'Web'} - ${navigator.userAgent.split('/')[0]}`;
      const result = await api.devices.startLinking(deviceId, name);
      setLinkToken(result?.token || null);
      setPolling(true);
      pollLinkStatus();
      pollTimer = window.setInterval(() => { void pollLinkStatus(); }, 3000);
      await loadPending();
    } catch (e) {
      setLinkError(e?.message || 'FAILED TO START LINKING');
    }
  };

  const revokeClick = async (id) => {
    if (!confirmTimer.confirm(id)) return;
    setError('');
    try {
      await api.devices.revoke(id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      setError(e?.message || 'FAILED TO REVOKE DEVICE');
    }
  };

  const handleApprove = async () => {
    const token = approveToken().trim();
    setApproveError('');
    setApproveMessage('');
    if (!token) {
      setApproveError('TOKEN IS REQUIRED');
      return;
    }
    if (!approverPassword().trim()) {
      setApproveError('APPROVER PASSWORD IS REQUIRED');
      return;
    }
    setApproving(true);
    try {
      await api.devices.approveLinking(token, approverPassword());
      setApproveToken('');
      setApproverPassword('');
      setApproveMessage('DEVICE APPROVED');
      await loadDevices();
      await loadPending();
    } catch (e) {
      setApproveError(e?.message || 'APPROVAL FAILED');
    } finally {
      setApproving(false);
    }
  };

  onMount(() => {
    void loadDevices();
    void loadPending();
    pendingTimer = window.setInterval(() => { void loadPending(); }, 15000);
  });

  onCleanup(() => {
    if (pendingTimer) clearInterval(pendingTimer);
    stopPolling();
  });

  return (
    <div class="text-xs flex flex-col gap-3">
      <Show when={requiresVaultAuth()}>
        <div data-testid="devices-gate" class="text-bb-muted">
          UNLOCK VAULT TO MANAGE DEVICES // SEE [VAULT] SECTION ABOVE
        </div>
      </Show>

      <Show when={!requiresVaultAuth()}>
        <Show when={loading()}>
          <div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>
        </Show>
        <Show when={!loading()}>
          <Show when={devices().length > 0} fallback={<div class="text-bb-muted">NO DEVICES YET</div>}>
            <div class="flex flex-col gap-1">
              <For each={devices()}>
                {(device) => (
                  <div data-testid="device-row" class="flex items-center gap-3 py-1 border-b border-bb-border/30">
                    <span class="flex-1 text-bb-text">
                      {device.name || 'UNKNOWN DEVICE'}
                      {device.is_primary ? <span class="ml-2 text-bb-accent">[PRIMARY]</span> : null}
                      {vaultService.getDeviceId() === device.device_public_id ? <span class="ml-2 text-bb-muted">[THIS DEVICE]</span> : null}
                    </span>
                    <span class="text-bb-muted">
                      {device.created_at ? new Date(device.created_at).toLocaleDateString() : 'UNKNOWN'}
                    </span>
                    <Show when={!device.is_primary && vaultService.getDeviceId() !== device.device_public_id}>
                      <button
                        type="button"
                        data-testid="device-revoke"
                        onClick={() => revokeClick(device.id)}
                        onBlur={() => confirmTimer.disarm(device.id)}
                        class="px-2 py-0.5 border border-market-down text-market-down hover:bg-market-down/20 uppercase font-bold"
                      >
                        {confirmTimer.isArmed(device.id) ? '[CONFIRM?]' : '[REVOKE]'}
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="border-t border-bb-border/40 pt-3 mt-2">
            <div class="text-bb-muted uppercase font-bold mb-2">PENDING LINK REQUESTS</div>
            <Show when={pendingLoading()}>
              <div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>
            </Show>
            <Show when={!pendingLoading()}>
              <Show when={pending().length > 0} fallback={<div class="text-bb-muted">NO PENDING REQUESTS</div>}>
                <div class="flex flex-col gap-1">
                  <For each={pending()}>
                    {(request) => (
                      <div data-testid="device-pending-row" class="flex items-center gap-3 py-1 border-b border-bb-border/30">
                        <span class="flex-1 text-bb-text">{request.device_name || 'NEW DEVICE'}</span>
                        <span class="text-bb-muted">
                          EXPIRES: {request.expires_at ? new Date(request.expires_at).toLocaleDateString() : 'UNKNOWN'}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>

            <div class="flex items-center gap-3 mt-3">
              <button
                type="button"
                data-testid="device-link-start"
                disabled={Boolean(linkToken()) || Boolean(polling())}
                onClick={startLinking}
                class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
              >
                [LINK NEW DEVICE]
              </button>
              <Show when={polling()}>
                <span class="text-bb-muted">WAITING FOR APPROVAL...</span>
              </Show>
              <Show when={linkError()}>
                <span class="text-market-down">ERROR // {linkError().toUpperCase()}</span>
              </Show>
            </div>
            <Show when={linkToken()}>
              <div data-testid="device-link-token" class="mt-2 break-all text-bb-text">
                TOKEN: {linkToken()}
              </div>
            </Show>
          </div>

          <div class="border-t border-bb-border/40 pt-3 mt-2">
            <div class="text-bb-muted uppercase font-bold mb-2">APPROVE LINK REQUEST</div>
            <div class="flex flex-col gap-2 max-w-sm">
              <input
                type="text"
                data-testid="device-approve-token"
                placeholder="LINKING TOKEN"
                value={approveToken()}
                onInput={(e) => setApproveToken(e.currentTarget.value)}
                class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
              />
              <input
                type="password"
                data-testid="device-approve-password"
                placeholder="APPROVER PASSWORD"
                value={approverPassword()}
                onInput={(e) => setApproverPassword(e.currentTarget.value)}
                class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
              />
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  data-testid="device-approve-submit"
                  disabled={approving()}
                  onClick={handleApprove}
                  class="px-3 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent disabled:opacity-50 uppercase font-bold"
                >
                  {approving() ? '[APPROVING...]' : '[APPROVE]'}
                </button>
                <Show when={approveMessage()}>
                  <span class="text-market-up">{approveMessage()}</span>
                </Show>
                <Show when={approveError()}>
                  <span class="text-market-down">ERROR // {approveError().toUpperCase()}</span>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={error()}>
        <div class="text-market-down">ERROR // {error().toUpperCase()}</div>
      </Show>
    </div>
  );
}
