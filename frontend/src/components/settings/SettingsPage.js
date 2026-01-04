import van from 'vanjs-core';
import VaultSettings from '../vault/VaultSettings.js';
import PasskeyManager from './PasskeyManager.js';
import DeviceManager from './DeviceManager.js';

const { div, h1, h2, p, button, label, input, span } = van.tags;

// Dark mode state
const isDarkMode = van.state(false);

const toggleDarkMode = () => {
  isDarkMode.val = !isDarkMode.val;
  if (isDarkMode.val) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
  localStorage.setItem('darkMode', isDarkMode.val);
};

// Initialize dark mode from localStorage
const savedDarkMode = localStorage.getItem('darkMode');
if (savedDarkMode !== null) {
  isDarkMode.val = savedDarkMode === 'true';
  if (isDarkMode.val) {
    document.body.classList.add('dark-mode');
  }
}

export default function SettingsPage() {
  return div({ class: 'settings-page' },
    h1('Settings'),

    div({ class: 'setting-item' },
      label(
        input({
          type: 'checkbox',
          checked: isDarkMode,
          onchange: toggleDarkMode
        }),
        ' Dark Mode'
      )
    ),

    // Passkey Management
    PasskeyManager(),

    // Device Management
    DeviceManager(),

    // Vault encryption settings
    VaultSettings()
  );
}
