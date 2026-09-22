import { createSignal, onMount, For, Show } from 'solid-js';
import { aiApi } from '../../services/api';

export default function PostCritiqueSettings() {
  const [model, setModel] = createSignal('');
  const [options, setOptions] = createSignal([]);
  const [busy, setBusy] = createSignal(true);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  onMount(async () => {
    try { const data = await aiApi.critiqueSettings(); setOptions(data.options || []); setModel(data.model); }
    catch { setError('Could not load critique settings. Reload to try again.'); }
    finally { setBusy(false); }
  });
  return <section class="ai-settings settings-section">
    <h3 class="settings-section-title">Public critiques on my posts</h3>
    <p>Choose the reviewer for your new posts. Feedback is public and paid for by Intellacc.</p>
    <form onSubmit={async (event) => {
      event.preventDefault(); if (busy()) return;
      setBusy(true); setError(''); setMessage('');
      try { await aiApi.saveCritiqueSettings(model()); setMessage('Critique settings saved. Applies to future reviews.'); }
      catch { setError('Could not save critique settings. Try again.'); }
      finally { setBusy(false); }
    }}>
      <label>Public critique model
        <select aria-label="Public critique model" value={model()} disabled={busy() || !options().length}
          onChange={(event) => setModel(event.currentTarget.value)}>
          <For each={options()}>{(option) => <option value={option.id}>{option.label}</option>}</For>
        </select>
      </label>
      <p class="ai-privacy">Turning reviews off leaves existing critiques visible. Your choice does not change market matching.</p>
      <button type="submit" disabled={busy() || !options().length}>Save critique settings</button>
    </form>
    <Show when={message()}><p role="status">{message()}</p></Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </section>;
}
