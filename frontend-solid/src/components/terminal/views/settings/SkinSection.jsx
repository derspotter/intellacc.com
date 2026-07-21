import { For } from 'solid-js';
import { getActiveSkin, setSkin, VALID_SKINS } from '../../../../services/skinProvider';
import { updateUiPreferences } from '../../../../services/api';
import { isAuthenticated } from '../../../../services/auth';

export default function SkinSection() {
  const active = getActiveSkin;

  const choose = (skin) => {
    setSkin(skin);
    if (isAuthenticated()) {
      updateUiPreferences(skin).catch(() => { /* local switch already applied */ });
    }
  };

  return (
    <div class="flex gap-2 text-xs">
      <For each={VALID_SKINS}>
        {(skin) => (
          <button
            type="button"
            data-testid={`settings-skin-${skin}`}
            onClick={() => choose(skin)}
            class={`px-3 py-1 border uppercase font-bold ${
              active() === skin
                ? 'bg-bb-accent/15 text-bb-accent border-bb-accent'
                : 'border-bb-border text-bb-muted hover:text-bb-text hover:border-bb-text'
            }`}
          >
            [{skin.toUpperCase()}]
          </button>
        )}
      </For>
    </div>
  );
}
