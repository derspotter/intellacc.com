import { FeedPanel } from "./components/FeedPanel";
import { MarketPanel } from "./components/MarketPanel";
import { Panel } from "./components/ui/Panel";
import { ThreePaneLayout } from "./components/ui/ThreePaneLayout";
import { useSocket } from "./services/socket";
import { onMount } from "solid-js";

import { createSignal, onCleanup, Show } from "solid-js";
import { userData, isLoggedIn } from "./services/tokenService";
import { LoginModal } from "./components/auth/LoginModal";

import { ChatPanel } from "./components/ChatPanel";

function App() {
  const { connect, state: socketState } = useSocket();
  const [time, setTime] = createSignal(new Date());

  onMount(() => {
    connect();
    const timer = setInterval(() => setTime(new Date()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  const formatDate = (date) => {
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
  };

  const formatTime = (date) => {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div class="h-screen w-screen bg-bb-bg text-bb-text font-sans overflow-hidden flex flex-col">
      <Show when={!isLoggedIn()}>
        <LoginModal />
      </Show>

      {/* Top Bar (Tmux Style) */}
      <header class="h-6 shrink-0 flex items-stretch text-xs font-mono z-20 relative select-none bg-bb-tmux text-bb-bg font-bold">
        {/* Left Block */}
        <div class="px-3 flex items-center border-r border-bb-bg/20 gap-2">
          <span>[INTELLACC] USER: @{userData()?.username || 'GUEST'}</span>
          <Show when={isLoggedIn()}>
            <button
              onClick={() => {
                import("./services/tokenService").then(s => s.clearToken());
              }}
              class="hover:text-bb-accent cursor-pointer"
            >
              [LOGOUT]
            </button>
          </Show>
        </div>

        {/* Middle Spacer */}
        <div class="flex-1 flex items-center justify-end px-3 gap-4">
          <span>NET: {socketState.latency}ms</span>
          <span>|</span>
          <span>SYS: {socketState.connected ? 'ONLINE' : 'OFFLINE'}</span>
        </div>

        {/* Right Block */}
        <div class="px-3 flex items-center border-l border-bb-bg/20">
          {formatTime(time())} {formatDate(time())}
        </div>
      </header>

      {/* Resizable Grid */}
      <div class="flex-1 min-h-0 relative z-10">
        <ThreePaneLayout
          left={<FeedPanel />}
          center={<MarketPanel />}
          right={<ChatPanel />}
        />
      </div>
    </div>
  );
}

export default App;
