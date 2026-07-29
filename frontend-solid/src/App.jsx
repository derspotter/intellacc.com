import { lazy, onMount, Show } from 'solid-js';

// Only the active skin's chunk loads — the other shell (and everything it
// imports) stays off the wire and out of the parse budget entirely.
const TerminalApp = lazy(() => import('./components/TerminalApp'));
const VanApp = lazy(() => import('./VanApp'));
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
