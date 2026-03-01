import van from 'vanjs-core';
import {
  activeSkin,
  saveSkinPreference,
  clearQuerySkinOverride
} from '../../services/skinProvider';

const { div, h3, p, label, select, option } = van.tags;

export default function SkinPreferenceSettings() {
  const saving = van.state(false);
  const status = van.state('');

  const onSkinChange = async (event) => {
    const nextSkin = event.target.value;
    status.val = '';
    saving.val = true;

    try {
      clearQuerySkinOverride();
      await saveSkinPreference(nextSkin);
      status.val = 'Saved';
    } catch (error) {
      if (error?.status === 400) {
        status.val = error.message || 'Invalid skin choice.';
      } else if (error?.status === 401) {
        status.val = 'Sign in to sync skin preference.';
      } else {
        status.val = 'Saved locally. Sync to account failed.';
      }
      console.error('Failed to save UI skin preference:', error);
    } finally {
      saving.val = false;
      setTimeout(() => {
        status.val = '';
      }, 2000);
    }
  };

  return div({ class: 'settings-section skin-preference-settings' }, [
    h3({ class: 'settings-section-title' }, 'UI Skin'),

    p('Choose how the app is rendered. Logged-in users sync this preference to your account.'),

    div({ class: 'setting-item' }, [
      label(
        'Skin style',
        select({
          onchange: onSkinChange,
          disabled: () => saving.val,
          value: activeSkin,
          'aria-label': 'Skin style'
        }, [
          option({ value: 'van' }, 'Van-style'),
          option({ value: 'terminal' }, 'Terminal/Bloomberg')
        ])
      )
    ]),

    () => saving.val
      ? p({ class: 'text-muted' }, 'Saving...')
      : status.val
        ? p({ class: 'text-success' }, status.val)
        : null
  ]);
}
