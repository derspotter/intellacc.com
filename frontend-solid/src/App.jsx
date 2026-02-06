import { FeedPanel } from "./components/FeedPanel";
import { MarketPanel } from "./components/MarketPanel";
import { ThreePaneLayout } from "./components/ui/ThreePaneLayout";
import { useSocket } from "./services/socket";
import { createSignal, createEffect, onCleanup, onMount, Show, For } from "solid-js";
import { userData, isLoggedIn } from "./services/tokenService";
import { LoginModal } from "./components/auth/LoginModal";
import { ChatPanel } from "./components/ChatPanel";
import { feedStore } from "./store/feedStore";
import { marketStore } from "./store/marketStore";

function App() {
  const { connect, disconnect, state: socketState } = useSocket();
  const [time, setTime] = createSignal(new Date());

  // Navigation State
  // 1: Left (Feed), 2: Center (Market), 3: Right (Chat)
  const [activePane, setActivePane] = createSignal(2);
  const [showHelp, setShowHelp] = createSignal(false);
  const [showNotifications, setShowNotifications] = createSignal(false);
  const [showPalette, setShowPalette] = createSignal(false);
  const [paletteQuery, setPaletteQuery] = createSignal("");
  
  let helpRef;
  let notificationsRef;
  let paletteRef;
  let searchInputRef;

  // Actions for Command Palette
  const allActions = [
    { id: 'feed', label: 'Focus Feed', shortcut: '1', action: () => setActivePane(1) },
    { id: 'market', label: 'Focus Market', shortcut: '2', action: () => setActivePane(2) },
    { id: 'chat', label: 'Focus Chat', shortcut: '3', action: () => setActivePane(3) },
    { id: 'help', label: 'Toggle Help', shortcut: '?', action: () => setShowHelp(prev => !prev) },
    { id: 'logout', label: 'Logout', shortcut: '', action: () => import("./services/tokenService").then(s => s.clearToken()) }
  ];

  const filteredActions = () => {
    const q = paletteQuery().toLowerCase();
    return allActions.filter(a => 
      a.label.toLowerCase().includes(q) || 
      a.id.toLowerCase().includes(q)
    );
  };

  const executeAction = (action) => {
    action.action();
    setShowPalette(false);
    setPaletteQuery("");
  };

  // Auth-driven socket + data hydration
  createEffect(() => {
    if (isLoggedIn()) {
      connect();
      feedStore.loadPosts();
      marketStore.loadMarkets();
	    } else {
	      disconnect();
	      feedStore.clear();
	      marketStore.clear();
	      setShowNotifications(false);
	    }
	  });

  // Focus Trap Logic
  const handleFocusTrap = (e, containerRef) => {
    if (!containerRef) return;
    const focusableElements = containerRef.querySelectorAll(
      'a[href], button, textarea, input[type="text"], input[type="radio"], input[type="checkbox"], select'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.key === 'Tab') {
      if (e.shiftKey) { /* shift + tab */
        if (document.activeElement === firstElement) {
          lastElement.focus();
          e.preventDefault();
        }
      } else { /* tab */
        if (document.activeElement === lastElement) {
          firstElement.focus();
          e.preventDefault();
        }
      }
    }
  };

  createEffect(() => {
     if (showPalette() && searchInputRef) {
         searchInputRef.focus();
     }
  });

  onMount(() => {
    const handleKeydown = (e) => {
        // Ignore if user is typing in an input/textarea
        const isInput = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
        
        // Command Palette (Ctrl+K or Cmd+K)
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            if (!isInput) {
                e.preventDefault();
                setShowPalette(prev => !prev);
                return;
            }
        }

	        // Close Modals on ESC
	        if (e.key === 'Escape') {
	            if (showPalette()) {
	                setShowPalette(false);
	                setPaletteQuery("");
	                return;
	            }
	            if (showNotifications()) {
	                setShowNotifications(false);
	                return;
	            }
	            if (showHelp()) {
	                setShowHelp(false);
	                return;
	            }
	            if (isInput) {
                e.target.blur();
                return;
            }
        }

        // Focus Trap Handling
	        if (showPalette()) {
	            handleFocusTrap(e, paletteRef);
	            return; // Trap focus, don't trigger other shortcuts
	        }
	        if (showNotifications()) {
	            handleFocusTrap(e, notificationsRef);
	            return; // Trap focus
	        }
	        if (showHelp()) {
	            handleFocusTrap(e, helpRef);
	            return; // Trap focus
	        }

        if (!isInput) {
            if (e.key === '1') setActivePane(1);
            if (e.key === '2') setActivePane(2);
            if (e.key === '3') setActivePane(3);
            if (e.key === '?') setShowHelp(prev => !prev);
        }
    };

    window.addEventListener('keydown', handleKeydown);
    onCleanup(() => window.removeEventListener('keydown', handleKeydown));
  });

  // Clock timer
  const timer = setInterval(() => setTime(new Date()), 1000);
  onCleanup(() => clearInterval(timer));

  const formatDate = (date) => {
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
  };

	  const formatTime = (date) => {
	    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
	  };

	  const formatNotifTime = (ts) => {
	    try {
	      return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	    } catch {
	      return '--:--:--';
	    }
	  };

	  const notificationsNewestFirst = () => (socketState.notifications || []).slice().reverse();

	  return (
	    <div class="h-screen w-screen bg-bb-bg text-bb-text font-sans overflow-hidden flex flex-col relative">
      <Show when={!isLoggedIn()}>
        <LoginModal />
      </Show>

      {/* Command Palette Overlay */}
      <Show when={showPalette()}>
        <div class="absolute inset-0 z-[60] bg-black/80 flex items-start justify-center pt-20 backdrop-blur-sm" onClick={() => setShowPalette(false)}>
            <div 
                ref={el => paletteRef = el}
                class="bg-bb-panel border border-bb-accent shadow-glow-green max-w-lg w-full overflow-hidden flex flex-col" 
                onClick={e => e.stopPropagation()}
            >
                <div class="p-3 border-b border-bb-border flex items-center gap-2">
                    <span class="text-bb-accent font-bold">{'>'}</span>
                    <input 
                        ref={el => searchInputRef = el}
                        type="text" 
                        class="bg-transparent border-none outline-none text-bb-text flex-1 font-mono placeholder-bb-muted"
                        placeholder="Type a command..."
                        value={paletteQuery()}
                        onInput={(e) => setPaletteQuery(e.target.value)}
                    />
                    <span class="text-xs text-bb-muted font-mono">ESC to close</span>
                </div>
                <div class="max-h-64 overflow-y-auto">
                    <For each={filteredActions()}>
                        {(item) => (
                            <button 
                                class="w-full text-left px-4 py-3 hover:bg-bb-active/20 flex items-center justify-between group border-l-2 border-transparent hover:border-bb-accent transition-colors"
                                onClick={() => executeAction(item)}
                            >
                                <span class="font-mono group-hover:text-bb-highlight">{item.label}</span>
                                <Show when={item.shortcut}>
                                    <span class="text-xs text-bb-muted font-mono bg-bb-bg/50 px-1 rounded border border-bb-border">{item.shortcut}</span>
                                </Show>
                            </button>
                        )}
                    </For>
                    <Show when={filteredActions().length === 0}>
                        <div class="p-4 text-center text-bb-muted font-mono text-sm">No commands found</div>
                    </Show>
                </div>
            </div>
        </div>
      </Show>

	      {/* Help Overlay */}
	      <Show when={showHelp()}>
	          <div class="absolute inset-0 z-50 bg-black/80 flex items-center justify-center backdrop-blur-sm" onClick={() => setShowHelp(false)}>
	              <div ref={el => helpRef = el} class="bg-bb-panel border border-bb-border p-6 shadow-glow-green max-w-md w-full" onClick={e => e.stopPropagation()}>
                  <h2 class="text-bb-accent font-mono text-xl mb-4 border-b border-bb-border pb-2">[SHORTCUTS]</h2>
                  <div class="space-y-2 font-mono text-sm">
                      <div class="flex justify-between">
                          <span class="text-bb-tmux">1</span>
                          <span>Focus FEED Panel</span>
                      </div>
                      <div class="flex justify-between">
                          <span class="text-bb-tmux">2</span>
                          <span>Focus MARKET Panel</span>
                      </div>
                      <div class="flex justify-between">
                          <span class="text-bb-tmux">3</span>
                          <span>Focus CHAT Panel</span>
                      </div>
                      <div class="flex justify-between">
                          <span class="text-bb-tmux">?</span>
                          <span>Toggle Help</span>
                      </div>
                      <div class="flex justify-between">
                          <span class="text-bb-tmux">Ctrl+K</span>
                          <span>Command Palette</span>
                      </div>
                      <div class="flex justify-between">
                          <span class="text-bb-tmux">ESC</span>
                          <span>Unfocus / Close</span>
                      </div>
                  </div>
                  <div class="mt-6 text-center text-xs text-bb-muted">
                      PRESS 'ESC' TO CLOSE
                  </div>
              </div>
	          </div>
	      </Show>

	      {/* Notifications Overlay */}
	      <Show when={showNotifications()}>
	          <div class="absolute inset-0 z-50 bg-black/80 flex items-center justify-center backdrop-blur-sm" onClick={() => setShowNotifications(false)}>
	              <div ref={el => notificationsRef = el} class="bg-bb-panel border border-bb-border p-6 shadow-glow-green max-w-lg w-full" onClick={e => e.stopPropagation()}>
	                  <h2 class="text-bb-accent font-mono text-xl mb-4 border-b border-bb-border pb-2">[NOTIFICATIONS]</h2>
	                  <div class="font-mono text-sm max-h-80 overflow-auto border border-bb-border/60 bg-bb-bg/20">
	                      <Show
	                        when={(socketState.notifications?.length || 0) > 0}
	                        fallback={<div class="p-3 text-bb-muted">NO NOTIFICATIONS YET</div>}
	                      >
	                        <For each={notificationsNewestFirst()}>
	                          {(n) => (
	                            <div class="px-3 py-2 border-b border-bb-border/40 flex gap-3">
	                              <span class="text-bb-tmux shrink-0">{formatNotifTime(n.ts)}</span>
	                              <span class="min-w-0 break-words">{n.text}</span>
	                            </div>
	                          )}
	                        </For>
	                      </Show>
	                  </div>
	                  <div class="mt-4 text-center text-xs text-bb-muted">
	                      PRESS 'ESC' TO CLOSE
	                  </div>
	              </div>
	          </div>
	      </Show>

      {/* Top Bar (Tmux Style) */}
      <header class="min-h-6 shrink-0 flex items-stretch text-xs font-mono z-20 relative select-none bg-bb-tmux text-bb-bg font-bold overflow-x-auto no-scrollbar whitespace-nowrap">
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
	          <span>SYS: {socketState.connected ? 'ONLINE' : 'OFFLINE'}</span>
	          <button
	            type="button"
	            class="max-w-[40vw] sm:max-w-[50vw] truncate hover:text-bb-accent cursor-pointer"
	            title={socketState.lastNotification || ''}
	            onClick={() => setShowNotifications(true)}
	          >
	            NOTIF: {socketState.lastNotification || '-'}
	          </button>
	        </div>

        {/* Right Block */}
        <div class="px-3 flex items-center border-l border-bb-bg/20">
          {formatTime(time())} {formatDate(time())}
        </div>
      </header>

      {/* Resizable Grid */}
      <div class="flex-1 min-h-0 relative z-10">
        <ThreePaneLayout
          activePane={activePane()}
          left={<FeedPanel isActive={activePane() === 1} />}
          center={<MarketPanel isActive={activePane() === 2} />}
          right={<ChatPanel isActive={activePane() === 3} />}
        />
      </div>

      {/* Mobile Bottom Tabs (< md) */}
      <Show when={isLoggedIn()}>
        <nav class="md:hidden shrink-0 h-12 bg-bb-panel border-t border-bb-border flex font-mono text-xs select-none">
          <button
            type="button"
            onClick={() => setActivePane(1)}
            class={`flex-1 flex items-center justify-center gap-2 border-r border-bb-border ${
              activePane() === 1 ? "bg-bb-accent/15 text-bb-accent font-bold" : "text-bb-muted hover:text-bb-text hover:bg-white/5"
            }`}
          >
            <span class="text-[10px] opacity-80">[1]</span>
            <span>FEED</span>
          </button>
          <button
            type="button"
            onClick={() => setActivePane(2)}
            class={`flex-1 flex items-center justify-center gap-2 border-r border-bb-border ${
              activePane() === 2 ? "bg-bb-accent/15 text-bb-accent font-bold" : "text-bb-muted hover:text-bb-text hover:bg-white/5"
            }`}
          >
            <span class="text-[10px] opacity-80">[2]</span>
            <span>MARKET</span>
          </button>
          <button
            type="button"
            onClick={() => setActivePane(3)}
            class={`flex-1 flex items-center justify-center gap-2 ${
              activePane() === 3 ? "bg-bb-accent/15 text-bb-accent font-bold" : "text-bb-muted hover:text-bb-text hover:bg-white/5"
            }`}
          >
            <span class="text-[10px] opacity-80">[3]</span>
            <span>CHAT</span>
          </button>
        </nav>
      </Show>
    </div>
  );
}

export default App;
