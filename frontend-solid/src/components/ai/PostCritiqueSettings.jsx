import { createSignal, onMount, Show } from 'solid-js';
import { aiApi } from '../../services/api';
import ai from '../../store/aiStore';

export default function PostCritiqueSettings() {
  const [model, setModel] = createSignal('');
  const [enabled, setEnabled] = createSignal(false);
  const [loaded, setLoaded] = createSignal(null);
  const [busy, setBusy] = createSignal(true);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const configured = () => ai.state.settings
    ? ai.state.settings.configured && ai.state.settings.available !== false : loaded()?.configured;
  onMount(async () => {
    try { const data = await aiApi.critiqueSettings(); setLoaded(data); setModel(data.model || ''); setEnabled(data.enabled); }
    catch { setError('Could not load critique settings. Reload to try again.'); }
    finally { setBusy(false); }
  });
  return <section class="ai-settings settings-section">
    <h3 class="settings-section-title">Public critiques on my posts</h3>
    <p>Reviews use your saved provider and API key above. Usage is billed to your provider account.</p>
    <form onSubmit={async (event) => {
      event.preventDefault(); if (busy()) return;
      setBusy(true); setError(''); setMessage('');
      try { await aiApi.saveCritiqueSettings({ model: model().trim(), enabled: enabled() }); setMessage('Critique settings saved. Applies to future reviews.'); }
      catch (err) { setError(err.message || 'Could not save critique settings. Try again.'); }
      finally { setBusy(false); }
    }}>
      <label class="ai-checkbox"><input type="checkbox" checked={enabled()} disabled={busy()}
        onChange={(event) => setEnabled(event.currentTarget.checked)} />
        Automatically critique my new posts publicly using my API key
      </label>
      <label>Public critique model ID (optional)
        <input aria-label="Public critique model ID" value={model()} maxLength="128" disabled={busy()}
          placeholder={ai.state.settings?.model || 'Leave blank to use your AI assistant model'}
          onInput={(event) => setModel(event.currentTarget.value)} />
      </label>
      <p class="ai-privacy">Enter any model ID supported by your selected provider, or leave blank to use your AI assistant model. Existing critiques remain visible when reviews are turned off.</p>
      <Show when={!configured()}><p role="status">Save your own provider, model and API key above before enabling public critiques.</p></Show>
      <button type="submit" disabled={busy() || !loaded() || (enabled() && !configured())}>Save critique settings</button>
    </form>
    <Show when={message()}><p role="status">{message()}</p></Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </section>;
}
