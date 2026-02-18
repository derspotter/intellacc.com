import {
  createEffect,
  createSignal,
  Show
} from 'solid-js';
import { isAuthenticated, logout } from '../services/auth';
import { skinState, setSkin as setUiSkin } from '../services/skinProvider';
import { getUiPreferences as loadUiPreferences, updateUiPreferences, updateProfile } from '../services/api';

const isValidSkin = (value) => value === 'van' || value === 'terminal';

export default function SettingsPage() {
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [saveMessage, setSaveMessage] = createSignal('');
  const [saveError, setSaveError] = createSignal('');
  const [currentSkin, setCurrentSkin] = createSignal('van');

  const [displayName, setDisplayName] = createSignal('');
  const [savingProfile, setSavingProfile] = createSignal(false);
  const [profileMessage, setProfileMessage] = createSignal('');
  const [darkMode, setDarkMode] = createSignal(
    (() => {
      try {
        return localStorage.getItem('intellacc-dark') === 'true';
      } catch {
        return false;
      }
    })()
  );

  const applyDarkMode = (next) => {
    try {
      if (next) {
        document.body.classList.add('dark-mode');
      } else {
        document.body.classList.remove('dark-mode');
      }
      localStorage.setItem('intellacc-dark', next ? 'true' : 'false');
    } catch {
      // no-op
    }
  };

  const syncPreferences = async () => {
    try {
      setLoading(true);
      const skinPref = await loadUiPreferences();
      const nextSkin = isValidSkin(skinPref?.skin) ? skinPref.skin : skinState();
      setCurrentSkin(nextSkin);
      setUiSkin(nextSkin);
    } catch (error) {
      setSaveError(error?.message || 'Failed to load settings.');
    } finally {
      setLoading(false);
    }
  };

  const saveSkin = async (nextSkin) => {
    if (!isValidSkin(nextSkin) || !isAuthenticated()) {
      return;
    }
    try {
      setBusy(true);
      setSaveError('');
      setSaveMessage('');
      setCurrentSkin(nextSkin);
      setUiSkin(nextSkin);
      await updateUiPreferences(nextSkin);
      setSaveMessage('Skin preference saved.');
    } catch (error) {
      setSaveError(error?.message || 'Failed to save skin preference.');
    } finally {
      setBusy(false);
      setTimeout(() => setSaveMessage(''), 1400);
    }
  };

  const updateDisplayName = async (event) => {
    event.preventDefault();
    if (!isAuthenticated()) {
      return;
    }
    try {
      setSavingProfile(true);
      setProfileMessage('');
      const username = displayName().trim();
      if (!username) {
        setProfileMessage('Username cannot be empty.');
        return;
      }
      await updateProfile({ username });
      setProfileMessage('Display name saved.');
      window.setTimeout(() => setProfileMessage(''), 1400);
    } catch (error) {
      setProfileMessage(error?.message || 'Failed to save display name.');
    } finally {
      setSavingProfile(false);
    }
  };

  createEffect(() => {
    if (isAuthenticated()) {
      syncPreferences();
    }
  });

  createEffect(() => {
    applyDarkMode(darkMode());
  });

  return (
    <section class="settings-page">
      <h1>Settings</h1>
      <p class="muted">App preferences and account options.</p>

      <Show when={loading()}>
        <p>Loading settings…</p>
      </Show>
      <Show when={saveError()}>
        <p class="error">{saveError()}</p>
      </Show>

      <Show when={saveMessage()}>
        <p class="success">{saveMessage()}</p>
      </Show>

      <Show when={isAuthenticated()}>
        <div class="settings-group">
          <h2>Appearance</h2>
          <div class="settings-row">
            <label class="form-group">
              <span>Preferred skin</span>
              <div class="skin-buttons">
                <button
                  type="button"
                  class={`post-action ${currentSkin() === 'van' ? 'submit-button' : ''}`}
                  onClick={() => saveSkin('van')}
                  disabled={busy()}
                >
                  Van
                </button>
                <button
                  type="button"
                  class={`post-action ${currentSkin() === 'terminal' ? 'submit-button' : ''}`}
                  onClick={() => saveSkin('terminal')}
                  disabled={busy()}
                >
                  Terminal
                </button>
              </div>
            </label>
          </div>
          <label class="form-group">
            <span>
              <input
                type="checkbox"
                checked={darkMode()}
                onInput={(event) => setDarkMode(Boolean(event.target.checked))}
              />
              {' '}
              Dark mode (local-only)
            </span>
          </label>
        </div>

        <div class="settings-group">
          <h2>Profile</h2>
          <form class="profile-settings-form" onSubmit={updateDisplayName}>
            <label class="form-group">
              <span>Username</span>
              <input
                type="text"
                class="form-input"
                value={displayName()}
                onInput={(event) => setDisplayName(event.target.value)}
                placeholder="New username"
                disabled={savingProfile()}
              />
            </label>
            <button
              type="submit"
              class="post-action submit-button"
              disabled={savingProfile()}
            >
              {savingProfile() ? 'Saving…' : 'Save username'}
            </button>
            <Show when={profileMessage()}>
              <p class="muted">{profileMessage()}</p>
            </Show>
          </form>
        </div>

        <div class="settings-group">
          <h2>Session</h2>
          <button
            type="button"
            class="post-action"
            onClick={logout}
          >
            Sign out
          </button>
        </div>
      </Show>

      <Show when={!isAuthenticated()}>
        <p class="login-notice">
          Sign in to access settings.
        </p>
      </Show>
    </section>
  );
}
