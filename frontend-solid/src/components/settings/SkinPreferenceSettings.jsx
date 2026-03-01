import { Show, createSignal } from 'solid-js';
import { isAuthenticated } from '../../services/auth';
import {
  isValidSkin,
  getActiveSkin,
  setSkin as syncSkin,
  VALID_SKINS
} from '../../services/skinProvider';
import { updateUiPreferences } from '../../services/api';

export default function SkinPreferenceSettings() {
  const [saving, setSaving] = createSignal(false);
  const [status, setStatus] = createSignal('');

  const onSkinChange = async (event) => {
    const nextSkin = event.target.value;
    if (!isValidSkin(nextSkin)) {
      setStatus('Invalid skin choice.');
      return;
    }

    setSaving(true);
    setStatus('');
    syncSkin(nextSkin);

    try {
      if (isAuthenticated()) {
        await updateUiPreferences(nextSkin);
      }
      setStatus('Saved');
    } catch (error) {
      if (error?.status === 401) {
        setStatus('Sign in to sync skin preference.');
      } else if (error?.status === 400) {
        setStatus(error.message || 'Could not save skin preference.');
      } else {
        setStatus('Saved locally. Sync to account failed.');
      }
    } finally {
      setSaving(false);
      window.setTimeout(() => setStatus(''), 1800);
    }
  };

  return (
    <section class="settings-section skin-preference-settings">
      <h3 class="settings-section-title">UI Skin</h3>
      <p>Choose how the app is rendered. Logged-in users sync this preference to account settings.</p>
      <div class="setting-item">
        <label>
          Skin style
          <select
            value={getActiveSkin()}
            onChange={onSkinChange}
            disabled={saving()}
            aria-label="Skin style"
          >
            {VALID_SKINS.map((skin) => (
              <option value={skin}>
                {skin === 'van' ? 'Van style' : 'Terminal/Bloomberg'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Show when={saving()}>
        <p>Saving…</p>
      </Show>
      <Show when={status()}>
        <p>{status()}</p>
      </Show>
    </section>
  );
}
