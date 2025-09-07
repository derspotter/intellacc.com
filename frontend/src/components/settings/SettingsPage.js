import van from 'vanjs-core';

const { div, h1, p, button, label, input } = van.tags;

// Placeholder for dark mode state and toggle function
// We'll implement this later
const isDarkMode = van.state(false); // Default to light mode

const toggleDarkMode = () => {
  isDarkMode.val = !isDarkMode.val;
  // In a real app, you'd also save this to localStorage
  // and apply/remove a class to the body or root element
  console.log("Dark mode toggled:", isDarkMode.val);
  if (isDarkMode.val) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
  // Persist preference
  localStorage.setItem('darkMode', isDarkMode.val);
};

// Initialize dark mode from localStorage if available
const savedDarkMode = localStorage.getItem('darkMode');
if (savedDarkMode !== null) {
  isDarkMode.val = savedDarkMode === 'true';
  if (isDarkMode.val) {
    document.body.classList.add('dark-mode');
  }
}


import keyManager from '../../services/keyManager.js';
import { registerDevice, unlockWithBiometricsThenPassphrase, wrapPrivateKeyWithPassphrase } from '../../services/webauthnClient.js';

export default function SettingsPage() {
  const passphrase = van.state('');
  const status = van.derive(() => keyManager.isUnlocked() ? 'Unlocked' : 'Locked');

  const unlock = async () => {
    if (!passphrase.val) { alert('Enter your passphrase'); return; }
    const ok = await keyManager.unlock(passphrase.val);
    if (!ok) alert('Failed to unlock with provided passphrase');
  };
  const encryptAtRest = async () => {
    try {
      if (!passphrase.val) { alert('Enter a passphrase to encrypt at rest'); return; }
      const ok = await keyManager.encryptAtRest(passphrase.val);
      if (ok) alert('Private key encrypted at rest');
    } catch (e) {
      alert('Encrypt-at-rest failed: ' + (e.message || e));
    }
  };
  const lock = () => {
    keyManager.lockKeys();
  };

  const webauthnRegister = async () => {
    try {
      await registerDevice();
      alert('Device registered for biometrics/OS unlock');
    } catch (e) {
      alert('Registration failed: ' + (e.message || e));
    }
  };
  const saveWrappedKey = async () => {
    try {
      if (!passphrase.val) return alert('Enter passphrase to wrap key as fallback');
      await wrapPrivateKeyWithPassphrase(passphrase.val);
      alert('Wrapped key saved locally');
    } catch (e) {
      alert('Failed to wrap key: ' + (e.message || e));
    }
  };
  const unlockWithBiometrics = async () => {
    try {
      if (!passphrase.val) return alert('Enter the passphrase used when saving wrapped key');
      await unlockWithBiometricsThenPassphrase(passphrase.val);
      alert('Unlocked via biometrics/OS + passphrase unwrap');
    } catch (e) {
      alert('Unlock failed: ' + (e.message || e));
    }
  };

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
    div({ class: 'setting-item' },
      h1('Security'),
      p(() => `Key status: ${status.val}`),
      div(
        input({ type: 'password', placeholder: 'Passphrase', value: passphrase, oninput: e => passphrase.val = e.target.value }),
        button({ onclick: unlock }, 'Unlock'),
        button({ onclick: lock, style: 'margin-left:8px' }, 'Lock'),
        button({ onclick: encryptAtRest, style: 'margin-left:8px' }, 'Encrypt key at rest'),
      ),
      div(
        label('Auto-lock after (minutes): '),
        input({ type: 'number', min: 0, value: van.state(localStorage.getItem('idleLockMinutes') || '15'), oninput: e => {
          try { localStorage.setItem('idleLockMinutes', e.target.value); } catch {}
        } })
      ),
      div(
        button({ onclick: webauthnRegister }, 'Register this device (WebAuthn)'),
        button({ onclick: saveWrappedKey, style: 'margin-left:8px' }, 'Save wrapped key'),
        button({ onclick: unlockWithBiometrics, style: 'margin-left:8px' }, 'Unlock with biometrics')
      )
    )
  );
}
