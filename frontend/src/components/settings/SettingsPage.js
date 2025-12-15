import van from 'vanjs-core';
import VaultSettings from '../vault/VaultSettings.js';

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

    // Vault encryption settings
    VaultSettings()
  );
}
