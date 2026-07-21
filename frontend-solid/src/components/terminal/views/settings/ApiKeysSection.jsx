import { For, Show, createSignal, onMount } from 'solid-js';
import { api, ApiError } from '../../../../services/api';
import useConfirmTimer from '../../lib/useConfirmTimer';

export default function ApiKeysSection() {
  const [keys, setKeys] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [needsVerification, setNeedsVerification] = createSignal(false);
  const [error, setError] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [newKey, setNewKey] = createSignal(null);
  const [name, setName] = createSignal('');
  const [isBot, setIsBot] = createSignal(false);
  const confirmTimer = useConfirmTimer();

  const isVerificationError = (e) => e instanceof ApiError && (e.status === 403 || e.message === 'Forbidden');

  const loadKeys = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.users.getApiKeys();
      setKeys(res?.keys || []);
      setNeedsVerification(false);
    } catch (e) {
      if (isVerificationError(e)) {
        setNeedsVerification(true);
      } else {
        setError(e?.message || 'FAILED TO LOAD API KEYS');
      }
    } finally {
      setLoading(false);
    }
  };

  onMount(loadKeys);

  const create = async () => {
    const trimmed = name().trim();
    if (!trimmed) {
      setError('KEY NAME IS REQUIRED');
      return;
    }
    setCreating(true);
    setError('');
    setNewKey(null);
    try {
      const res = await api.users.createApiKey(trimmed, isBot());
      if (res?.apiKey) {
        setNewKey(res.apiKey);
        setName('');
        setIsBot(false);
        await loadKeys();
      }
    } catch (e) {
      if (isVerificationError(e)) {
        setNeedsVerification(true);
      } else {
        setError(e?.message || 'FAILED TO CREATE KEY');
      }
    } finally {
      setCreating(false);
    }
  };

  const revokeClick = async (id) => {
    if (!confirmTimer.confirm(id)) return;
    setError('');
    try {
      await api.users.revokeApiKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (e) {
      setError(e?.message || 'FAILED TO REVOKE KEY');
    }
  };

  return (
    <div class="text-xs">
      <Show when={loading()}>
        <div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>
      </Show>
      <Show when={!loading()}>
        <Show
          when={!needsVerification()}
          fallback={<div class="text-market-down">NEEDS EMAIL + PHONE VERIFICATION</div>}
        >
          <div class="flex items-center gap-2 mb-3 max-w-md">
            <input
              type="text"
              data-testid="apikey-name"
              placeholder="KEY NAME"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text flex-1 focus:outline-none focus:border-bb-accent"
            />
            <button
              type="button"
              onClick={() => setIsBot((b) => !b)}
              class={`px-2 py-1 border uppercase font-bold ${
                isBot() ? 'border-bb-accent text-bb-accent' : 'border-bb-border text-bb-muted hover:text-bb-text'
              }`}
            >
              [BOT]
            </button>
            <button
              type="button"
              data-testid="apikey-create"
              disabled={creating()}
              onClick={create}
              class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
            >
              {creating() ? '[CREATING...]' : '[CREATE KEY]'}
            </button>
          </div>

          <Show when={newKey()}>
            <div data-testid="apikey-reveal" class="mb-3 border border-market-up bg-market-up/10 p-2 max-w-md">
              <div class="text-market-up font-bold">COPY IT NOW // SHOWN ONCE</div>
              <div class="mt-1 break-all text-bb-text">{newKey()}</div>
            </div>
          </Show>

          <Show when={keys().length > 0} fallback={<div class="text-bb-muted">NO API KEYS ACTIVE</div>}>
            <div class="flex flex-col gap-1">
              <For each={keys()}>
                {(k) => (
                  <div data-testid="apikey-row" class="flex items-center gap-3 py-1 border-b border-bb-border/30">
                    <span class="flex-1 text-bb-text">{k.name}</span>
                    <span class="text-bb-muted uppercase">{k.is_bot ? 'BOT' : 'CLI'}</span>
                    <span class="text-bb-muted">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'NEVER'}
                    </span>
                    <button
                      type="button"
                      data-testid="apikey-revoke"
                      onClick={() => revokeClick(k.id)}
                      onBlur={() => confirmTimer.disarm(k.id)}
                      class="px-2 py-0.5 border border-market-down text-market-down hover:bg-market-down/20 uppercase font-bold"
                    >
                      {confirmTimer.isArmed(k.id) ? '[CONFIRM?]' : '[REVOKE]'}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
      <Show when={error()}>
        <div class="mt-2 text-market-down">ERROR // {error().toUpperCase()}</div>
      </Show>
    </div>
  );
}
