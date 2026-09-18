import { createSignal, onMount, Show } from 'solid-js';
import { aiApi } from '../../services/api';
import ai from '../../store/aiStore';
import './ai.css';

export default function AiSettings() {
  const [provider, setProvider] = createSignal('openrouter');
  const [model, setModel] = createSignal('');
  const [apiKey, setApiKey] = createSignal('');
  const [publicReplies, setPublicReplies] = createSignal(true);
  const [saved, setSaved] = createSignal(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  const apply = (data) => {
    setSaved(data); setProvider(data.provider || 'openrouter'); setModel(data.model || '');
    setPublicReplies(data.publicReplies !== false); setApiKey('');
  };
  const run = async (action) => {
    if (busy()) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (err) { setError(err.message || 'Could not update AI settings.'); }
    finally { setBusy(false); }
  };
  onMount(() => run(async () => apply(await ai.refreshSettings())));
  const dirty = () => apiKey() || provider() !== saved()?.provider || model() !== saved()?.model || publicReplies() !== saved()?.publicReplies;
  return (
    <section class="ai-settings settings-section">
      <h3 class="settings-section-title">Your AI assistant</h3>
      <p>Use your own API key and choose your model. Provider usage is billed to your account.</p>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => {
        await aiApi.saveSettings({ provider: provider(), model: model().trim(), publicReplies: publicReplies(), ...(apiKey().trim() ? { apiKey: apiKey().trim() } : {}) });
        apply(await ai.refreshSettings()); setMessage('AI settings saved.');
      }); }}>
        <label>Provider
          <select aria-label="Provider" value={provider()} disabled={busy()} onChange={(e) => { setProvider(e.currentTarget.value); setApiKey(''); setModel(''); }}>
            <option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option><option value="xai">xAI</option>
          </select>
        </label>
        <label>Model ID
          <input required value={model()} maxLength="128" placeholder="Model ID from your provider" disabled={busy()} onInput={(e) => setModel(e.currentTarget.value)} />
        </label>
        <label>API key
          <input type="password" autoComplete="new-password" value={apiKey()} maxLength="512" disabled={busy()}
            required={!saved()?.configured || provider() !== saved()?.provider}
            placeholder={saved()?.configured && provider() === saved()?.provider ? `Saved ${saved()?.keyHint || 'key'} · leave blank to keep` : 'Paste your provider API key'}
            onInput={(e) => setApiKey(e.currentTarget.value)} />
        </label>
        <label class="ai-checkbox"><input type="checkbox" checked={publicReplies()} disabled={busy()} onChange={(e) => setPublicReplies(e.currentTarget.checked)} />
          Allow public replies when I tag @ai in my posts or comments
        </label>
        <p class="ai-privacy">Keys are encrypted on the server. AI chats and selected post context are sent to your provider. Public @ai answers appear in the thread.</p>
        <Show when={saved()?.available === false}><p role="status">AI connections are not enabled on this server yet.</p></Show>
        <div class="ai-settings-actions">
          <button type="submit" disabled={busy() || saved()?.available === false}>Save AI settings</button>
          <button type="button" disabled={busy() || !saved()?.configured || Boolean(dirty())} onClick={() => run(async () => {
            await aiApi.test(); setMessage('Connection verified.');
          })}>Test saved connection</button>
          <Show when={saved()?.configured}>
            <button type="button" disabled={busy()} onClick={() => setConfirmRemove(true)}>Remove key</button>
          </Show>
        </div>
        <p class="ai-privacy">Testing sends a small request using your provider credits.</p>
      </form>
      <Show when={confirmRemove()}><div class="ai-delete-confirm">
        <span>Remove your saved API key?</span>
        <button type="button" disabled={busy()} onClick={() => run(async () => {
          await aiApi.removeSettings(); apply(await ai.refreshSettings()); setConfirmRemove(false); setMessage('API key removed.');
        })}>Remove saved key</button>
        <button type="button" onClick={() => setConfirmRemove(false)}>Keep</button>
      </div></Show>
      <Show when={busy()}><p role="status">Working…</p></Show>
      <Show when={message()}><p role="status">{message()}</p></Show>
      <Show when={error()}><p role="alert" class="ai-error">{error()}</p></Show>
    </section>
  );
}
