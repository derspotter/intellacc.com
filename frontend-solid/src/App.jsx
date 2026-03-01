import { onMount, Show } from 'solid-js';
import TerminalApp from './components/TerminalApp';
import VanApp from './VanApp';
import { getActiveSkin, syncSkinWithServer } from './services/skinProvider';
import { isAuthenticated } from './services/auth';

export default function App() {
  const activeSkin = getActiveSkin;

  onMount(() => {
    if (isAuthenticated()) {
      syncSkinWithServer().catch(() => null);
    }
  });

  return (
    <Show when={activeSkin() === 'terminal'} fallback={<VanApp />}>
      <TerminalApp />
    </Show>
  );
}
