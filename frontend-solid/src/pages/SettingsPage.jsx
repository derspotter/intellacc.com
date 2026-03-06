import { createSignal, onMount, Show } from 'solid-js';
import SkinPreferenceSettings from '../components/settings/SkinPreferenceSettings';
import PasskeyManager from '../components/settings/PasskeyManager';
import DeviceManager from '../components/settings/DeviceManager';
import VerificationSettings from '../components/verification/VerificationSettings';
import ApiKeysManager from '../components/settings/ApiKeysManager';
import NotificationSettings from '../components/settings/NotificationSettings';
import VaultSettings from '../components/settings/VaultSettings';
import PasswordResetCancel from '../components/settings/PasswordResetCancel';
import DangerZone from '../components/settings/DangerZone';
import AiFlaggedContent from '../components/admin/AiFlaggedContent';
import { isAdmin } from '../services/auth';

export default function SettingsPage() {
  const [isDarkMode, setIsDarkMode] = createSignal(false);

  const getSavedDarkMode = () => {
    try {
      const saved = localStorage.getItem('darkMode');
      return saved === 'true';
    } catch {
      return false;
    }
  };

  const applyDarkMode = (value) => {
    try {
      if (value) {
        document.body.classList.add('dark-mode');
      } else {
        document.body.classList.remove('dark-mode');
      }
    } catch {
      // Ignore environments where body/theme updates fail.
    }
  };

  const handleDarkModeToggle = (event) => {
    const next = event.target.checked;
    setIsDarkMode(next);
    applyDarkMode(next);
    try {
      localStorage.setItem('darkMode', String(next));
    } catch {
      // Ignore persistence errors.
    }
  };

  onMount(() => {
    const next = getSavedDarkMode();
    setIsDarkMode(next);
    applyDarkMode(next);
  });

  return (
    <section class="settings-page">
      <h1>Settings</h1>
      <SkinPreferenceSettings />
      <div class="settings-section appearance-settings">
        <h3 class="settings-section-title">Appearance</h3>
        <div class="setting-item">
          <label>
            <input
              type="checkbox"
              checked={isDarkMode()}
              onChange={handleDarkModeToggle}
            />
            {' '}Dark Mode
          </label>
        </div>
      </div>
      <PasskeyManager />
      <DeviceManager />
      <VerificationSettings />
      <ApiKeysManager />
      <Show when={isAdmin()}>
        <AiFlaggedContent />
      </Show>
      <NotificationSettings />
      <VaultSettings />
      <PasswordResetCancel />
      <DangerZone />
    </section>
  );
}
