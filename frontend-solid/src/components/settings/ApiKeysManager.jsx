import { createSignal, onMount, For, Show } from 'solid-js';
import { api, ApiError } from '../../services/api';

export default function ApiKeysManager() {
  const [keys, setKeys] = createSignal([]);
  const [error, setError] = createSignal('');
  const [isLoading, setIsLoading] = createSignal(true);
  const [isCreating, setIsCreating] = createSignal(false);
  const [newKeyDisplay, setNewKeyDisplay] = createSignal(null);
  const [keyName, setKeyName] = createSignal('');
  const [isBot, setIsBot] = createSignal(false);

  const loadKeys = async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await api.users.getApiKeys();
      if (response && response.keys) {
        setKeys(response.keys);
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.message === 'Forbidden')) {
        setError('You must complete Email and Phone verification before generating API keys.');
      } else {
        setError(err.message || 'Failed to load API keys');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateKey = async (e) => {
    e.preventDefault();
    const name = keyName().trim();

    if (!name) {
      setError('Key name is required');
      return;
    }

    setIsCreating(true);
    setError('');
    setNewKeyDisplay(null);

    try {
      const response = await api.users.createApiKey(name, isBot());
      if (response && response.apiKey) {
        setNewKeyDisplay(response.apiKey);
        setKeyName('');
        setIsBot(false);
        await loadKeys();
      }
    } catch (err) {
      setError(err.message || 'Failed to create key');
    } finally {
      setIsCreating(false);
    }
  };

  const handleRevokeKey = async (keyId) => {
    if (!window.confirm('Are you sure you want to revoke this key? Any scripts using it will immediately fail.')) return;

    setError('');
    try {
      await api.users.revokeApiKey(keyId);
      setKeys((prev) => prev.filter((k) => k.id !== keyId));
    } catch (err) {
      setError(err.message || 'Error revoking key');
    }
  };

  const copyToClipboard = () => {
    const val = newKeyDisplay();
    if (val) {
      navigator.clipboard.writeText(val).then(() => alert('Copied to clipboard!'));
    }
  };

  onMount(() => {
    loadKeys();
  });

  return (
    <div class="settings-section">
      <h3 class="settings-section-title">
        <span class="section-icon">🔑</span>
        Agent API Keys
      </h3>
      <p style="font-size: 0.85rem; color: var(--secondary-text); margin-bottom: 1rem;">
        Create secure, scoped API keys for headless bots or AI orchestrators (like OpenClaw). These keys bypass the need for passkeys but are strictly limited in what they can do.
      </p>

      <Show when={error() && error() !== 'You must complete Email and Phone verification before generating API keys.'}>
        <div style="background: rgba(255, 0, 0, 0.1); border: 1px solid red; color: red; padding: 0.75rem; border-radius: 4px; margin-bottom: 1rem; font-size: 0.9rem;">
          {error()}
        </div>
      </Show>

      <Show when={!isLoading()} fallback={<div style="text-align: center; padding: 1rem; color: var(--secondary-text);">Loading keys...</div>}>
        <Show 
          when={error() !== 'You must complete Email and Phone verification before generating API keys.'}
          fallback={
            <div class="verification-blocked" style="margin-bottom: 1rem; background: rgba(255, 0, 0, 0.05); border: 1px solid rgba(255, 0, 0, 0.2); padding: 1rem; border-radius: 4px; text-align: center;">
              <div class="blocked-icon" style="font-size: 2rem; margin-bottom: 0.5rem;">⚠️</div>
              <p class="error-message" style="color: var(--error-color); font-weight: bold; margin-bottom: 0.5rem;">Verification Required</p>
              <p class="blocked-message" style="color: var(--secondary-text); font-size: 0.9rem;">You must complete Email and Phone verification before generating API keys.</p>
            </div>
          }
        >
          <form onSubmit={handleCreateKey} style="background: var(--hover-bg); padding: 1rem; border-radius: 4px; border: 1px solid var(--border-color); margin-bottom: 1.5rem;">
            <h4 style="margin-top: 0; margin-bottom: 0.75rem; font-size: 1rem;">Generate New Key</h4>
            
            <div style="display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1rem;">
              <div>
                <label style="display: block; font-size: 0.85rem; color: var(--secondary-text); margin-bottom: 0.25rem;">Key Name (e.g. "Trading Bot Alpha")</label>
                <input 
                  type="text" 
                  value={keyName()}
                  onInput={(e) => setKeyName(e.target.value)}
                  placeholder="Enter a name"
                  style="width: 100%; box-sizing: border-box;"
                />
              </div>
              
              <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                <input 
                  type="checkbox" 
                  checked={isBot()}
                  onChange={(e) => setIsBot(e.target.checked)}
                  style="width: 1rem; height: 1rem; margin: 0;"
                />
                <span style="font-size: 0.9rem;">This is an AI/Bot (Appends ✨ tag)</span>
              </label>
            </div>
            
            <div style="display: flex; justify-content: flex-end;">
              <button type="submit" class="button-primary" disabled={isCreating()}>
                {isCreating() ? 'Generating...' : 'Generate Key'}
              </button>
            </div>
          </form>

          <Show when={newKeyDisplay()}>
            <div style="background: rgba(0, 128, 0, 0.1); border: 1px solid green; padding: 1rem; border-radius: 4px; margin-bottom: 1.5rem;">
              <p style="color: green; font-weight: bold; margin-top: 0; margin-bottom: 0.5rem;">Key Generated Successfully!</p>
              <p style="font-size: 0.9rem; margin-bottom: 0.75rem;">Please copy this key now. You will not be able to see it again.</p>
              <div style="display: flex; align-items: center; justify-content: space-between; background: var(--black-bg); color: #fff; padding: 0.5rem; border-radius: 4px;">
                <code style="word-break: break-all; font-size: 0.85rem; color: #a3e635;">{newKeyDisplay()}</code>
                <button type="button" onClick={copyToClipboard} style="background: transparent; border: 1px solid #555; color: #fff; border-radius: 4px; padding: 0.25rem 0.5rem; cursor: pointer; margin-left: 1rem; white-space: nowrap;">
                  📋 Copy
                </button>
              </div>
            </div>
          </Show>

          <Show when={keys().length > 0} fallback={<p style="text-align: center; color: var(--secondary-text); font-style: italic; font-size: 0.9rem;">No API keys active.</p>}>
            <div style="overflow-x: auto;">
              <table style="width: 100%; text-align: left; font-size: 0.9rem; border-collapse: collapse;">
                <thead>
                  <tr style="border-bottom: 1px solid var(--border-color);">
                    <th style="padding: 0.5rem; color: var(--secondary-text);">Name</th>
                    <th style="padding: 0.5rem; color: var(--secondary-text);">Type</th>
                    <th style="padding: 0.5rem; color: var(--secondary-text);">Created</th>
                    <th style="padding: 0.5rem; color: var(--secondary-text);">Last Used</th>
                    <th style="padding: 0.5rem; text-align: right; color: var(--secondary-text);">Action</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={keys()}>
                    {(k) => (
                      <tr style="border-bottom: 1px solid var(--border-color);">
                        <td style="padding: 0.5rem; font-weight: 500;">{k.name}</td>
                        <td style="padding: 0.5rem;">
                          {k.is_bot ? (
                            <span style="background: rgba(128, 0, 128, 0.1); color: purple; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.75rem; border: 1px solid rgba(128, 0, 128, 0.3);">AI/Bot</span>
                          ) : (
                            <span style="background: rgba(0, 0, 255, 0.1); color: blue; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.75rem; border: 1px solid rgba(0, 0, 255, 0.3);">CLI</span>
                          )}
                        </td>
                        <td style="padding: 0.5rem; color: var(--secondary-text);">{new Date(k.created_at).toLocaleDateString()}</td>
                        <td style="padding: 0.5rem; color: var(--secondary-text);">{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'Never'}</td>
                        <td style="padding: 0.5rem; text-align: right;">
                          <button onClick={() => handleRevokeKey(k.id)} class="btn-link" style="color: red;">Revoke</button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
