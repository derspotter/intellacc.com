import { FeedPanel } from "./FeedPanel";
import { MarketPanel } from "./MarketPanel";
import { ThreePaneLayout } from "./ui/ThreePaneLayout";
import { useSocket } from "../services/socket";
import { createSignal, createEffect, createMemo, onCleanup, onMount, Show, For } from "solid-js";
import { Dynamic } from "solid-js/web";
import { userData, isLoggedIn } from "../services/tokenService";
import { LoginModal } from "./auth/LoginModal";
import { ChatPanel } from "./ChatPanel";
import { feedStore } from "../store/feedStore";
import { marketStore } from "../store/marketStore";
import { getActiveSkin, setSkin } from "../services/skinProvider";
import { updateUiPreferences } from "../services/api";
import { isAuthenticated, isAdmin } from "../services/auth";
import { normalizeHashPath } from "../services/routes";
import { TerminalViewHost, closeTerminalView } from "./terminal/TerminalViewHost";
import { TERMINAL_VIEWS } from "./terminal/views/registry";
import { AUTH_SCREENS } from "./terminal/views/auth/AuthScreens";
import TerminalRPBalance from "./terminal/TerminalRPBalance";

// Logged-out auth routes rendered as a full-screen terminal layer instead of
// (or, for verify-email, on top of) LoginModal. See AuthScreens.jsx.
const AUTH_SCREEN_ROUTES = ['signup', 'forgot-password', 'reset-password', 'verify-email'];

function App() {
  const { connect, disconnect, state: socketState } = useSocket();
  const [time, setTime] = createSignal(new Date());

  // Navigation State
  // 1: Left (Feed), 2: Center (Market), 3: Right (Chat)
  const [activePane, setActivePane] = createSignal(2);
  // Hash-driven navigation. Pane routes focus a pane; registry routes open a
  // full-screen view; anything else leaves the panes as-is.
  const PANE_ROUTES = { home: 1, predictions: 2, messages: 3 };
  const [activeView, setActiveView] = createSignal(null); // { key, param } | null
  // Reactive hash-driven auth route (signup|forgot-password|reset-password|
  // verify-email) or null. Kept separate from activeView since it renders
  // even for logged-out users (who have no panes to focus yet).
  const [authRoute, setAuthRoute] = createSignal(null);

  const applyRoute = () => {
    const value = normalizeHashPath(window.location.hash);
    const [route, param] = value.split('/');
    if (PANE_ROUTES[route]) {
      setActivePane(PANE_ROUTES[route]);
      setActiveView(null);
      setAuthRoute(null);
      if (route === 'predictions' && param) {
        marketStore.ensureMarket(Number(param));
      }
    } else if (TERMINAL_VIEWS[route] && (!TERMINAL_VIEWS[route].adminOnly || isAdmin())) {
      setActiveView({ key: route, param: param || null });
      setAuthRoute(null);
    } else if (AUTH_SCREEN_ROUTES.includes(route)) {
      setActiveView(null);
      setAuthRoute(route);
    } else {
      setAuthRoute(null);
    }
  };

  // Focus a pane immediately AND sync the hash. Setting only the hash would
  // no-op when it already equals the target (no hashchange event fires).
  const goPane = (route) => {
    setActivePane(PANE_ROUTES[route]);
    setActiveView(null);
    window.location.hash = `#${route}`;
  };
  const [showHelp, setShowHelp] = createSignal(false);
  const [showNotifications, setShowNotifications] = createSignal(false);
  const [showPalette, setShowPalette] = createSignal(false);
  const [paletteQuery, setPaletteQuery] = createSignal("");
  const activeSkin = getActiveSkin;
  
  createEffect(() => {
    const skin = activeSkin();
    if (typeof document !== 'undefined') {
      document.body.classList.remove('skin-van', 'skin-terminal');
      document.body.classList.add(`skin-${skin}`);
    }
  });
  
  let helpRef;
  let notificationsRef;
  let paletteRef;
  let searchInputRef;

  // Switch back to the Van skin. setSkin is reactive, so App.jsx immediately
  // re-renders VanApp; the preference is persisted locally and synced to the
  // account when signed in (best-effort, mirrors SkinPreferenceSettings).
  const switchToVan = () => {
    setSkin('van');
    if (isAuthenticated()) {
      updateUiPreferences('van').catch(() => { /* local switch already applied */ });
    }
  };

  // Actions for Command Palette
  // Derived (not a static array) so the adminOnly filter re-evaluates when
  // isAdmin() changes. isAdmin() reads the reactive `token` signal (via
  // getTokenData() -> getToken()), so this memo re-derives on login/logout
  // mid-session — an admin logging in without a page reload now sees the
  // "Open Admin" entry immediately.
  const allActions = createMemo(() => [
    { id: 'feed', label: 'Focus Feed', shortcut: '1', action: () => goPane('home') },
    { id: 'market', label: 'Focus Market', shortcut: '2', action: () => goPane('predictions') },
    { id: 'chat', label: 'Focus Chat', shortcut: '3', action: () => goPane('messages') },
    ...Object.entries(TERMINAL_VIEWS).filter(([, v]) => !v.hidden && (!v.adminOnly || isAdmin())).map(([key, view]) => ({
      id: `view-${key}`,
      label: `Open ${view.title.charAt(0) + view.title.slice(1).toLowerCase()}`,
      shortcut: '',
      action: () => { window.location.hash = `#${key}`; }
    })),
    { id: 'help', label: 'Toggle Help', shortcut: '?', action: () => setShowHelp(prev => !prev) },
    { id: 'skin-van', label: 'Switch to Van Skin', shortcut: '', action: switchToVan },
    {
      id: 'logout', label: 'Logout', shortcut: '', action: () => {
        // Lock the vault alongside clearing the token so MLS keys and
        // decrypted messages don't outlive the session (mirrors auth.logout).
        import("../services/mls/vaultService").then((m) => m.default?.lockKeys?.()).catch(() => {});
        return import("../services/tokenService").then(s => s.clearToken());
      }
    }
  ]);

  const filteredActions = () => {
    const q = paletteQuery().toLowerCase();
    return allActions().filter(a =>
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
    applyRoute();
    window.addEventListener('hashchange', applyRoute);
    onCleanup(() => window.removeEventListener('hashchange', applyRoute));

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
	            if (activeView()) {
	                closeTerminalView();
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
            if (e.key === '1') goPane('home');
            if (e.key === '2') goPane('predictions');
            if (e.key === '3') goPane('messages');
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
	    <div
          class="h-screen w-screen bg-bb-bg text-bb-text font-sans overflow-hidden flex flex-col relative"
          data-skin={activeSkin()}
        >
      {/* Logged-out auth routes (signup/forgot-password/reset-password) swap
          in for LoginModal; verify-email renders on top regardless of login
          state (auto-confirms), matching the van skin's behavior. */}
      <Show
        when={authRoute()}
        fallback={<Show when={!isLoggedIn()}><LoginModal /></Show>}
      >
        <Dynamic component={AUTH_SCREENS[authRoute()]} />
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

	      {/* Resizable Grid */}
	      <div class="flex-1 min-h-0 relative z-10">
	        <ThreePaneLayout
	          activePane={activePane()}
          left={<FeedPanel isActive={activePane() === 1} />}
          center={<MarketPanel isActive={activePane() === 2} />}
          right={<ChatPanel isActive={activePane() === 3} />}
        />
        <Show when={activeView()}>
          <TerminalViewHost viewKey={activeView().key} param={activeView().param} />
        </Show>
      </div>

      {/* Mobile Bottom Tabs (< md) */}
      <Show when={isLoggedIn()}>
        <nav class="md:hidden shrink-0 h-12 bg-bb-panel border-t border-bb-border flex font-mono text-xs select-none">
          <button
            type="button"
            onClick={() => goPane('home')}
            class={`flex-1 flex items-center justify-center gap-2 border-r border-bb-border ${
              activePane() === 1 ? "bg-bb-accent/15 text-bb-accent font-bold" : "text-bb-muted hover:text-bb-text hover:bg-white/5"
            }`}
          >
            <span class="text-[10px] opacity-80">[1]</span>
            <span>FEED</span>
          </button>
          <button
            type="button"
            onClick={() => goPane('predictions')}
            class={`flex-1 flex items-center justify-center gap-2 border-r border-bb-border ${
              activePane() === 2 ? "bg-bb-accent/15 text-bb-accent font-bold" : "text-bb-muted hover:text-bb-text hover:bg-white/5"
            }`}
          >
            <span class="text-[10px] opacity-80">[2]</span>
            <span>MARKET</span>
          </button>
          <button
            type="button"
            onClick={() => goPane('messages')}
            class={`flex-1 flex items-center justify-center gap-2 ${
              activePane() === 3 ? "bg-bb-accent/15 text-bb-accent font-bold" : "text-bb-muted hover:text-bb-text hover:bg-white/5"
            }`}
          >
            <span class="text-[10px] opacity-80">[3]</span>
            <span>CHAT</span>
          </button>
	        </nav>
	      </Show>

	      {/* Top Bar (Tmux Style) */}
	      <header class="min-h-6 shrink-0 flex items-stretch text-xs font-mono z-20 relative select-none bg-bb-tmux text-bb-bg font-bold overflow-x-auto no-scrollbar whitespace-nowrap">
	        {/* Left Block */}
	        <div class="px-3 flex items-center border-r border-bb-bg/20 gap-2">
	          <span>[INTELLACC] USER:</span>
	          <Show when={isLoggedIn()} fallback={<span>@GUEST</span>}>
	            <button
	              type="button"
	              data-testid="user-readout"
	              onClick={() => { window.location.hash = '#profile'; }}
	              class="hover:text-bb-accent cursor-pointer"
	              title="Open profile"
	            >
	              @{userData()?.username}
	            </button>
	          </Show>
	          <TerminalRPBalance />
	          <button
	            type="button"
	            onClick={switchToVan}
	            class="hover:text-bb-accent cursor-pointer"
	            title="Switch back to the Van skin"
	          >
	            [VAN]
	          </button>
	          <Show when={isLoggedIn()}>
	            <button
              onClick={() => {
                import("../services/tokenService").then(s => s.clearToken());
              }}
	              class="hover:text-bb-accent cursor-pointer"
	            >
	              [LOGOUT]
	            </button>
	          </Show>
	        </div>

	        {/* Window list (tmux style): persistent nav. Views are otherwise
	            palette/hotkey-driven, so the bar must always offer a visible
	            way back to the panes — e.g. after landing in #settings. */}
	        <div class="hidden sm:flex px-3 items-center gap-2 border-r border-bb-bg/20">
	          <For each={[['home', '1:FEED', 1], ['predictions', '2:MKT', 2], ['messages', '3:CHAT', 3]]}>
	            {([route, label, pane]) => (
	              <button
	                type="button"
	                data-testid={`nav-${route}`}
	                onClick={() => goPane(route)}
	                class={
	                  activePane() === pane && !activeView()
	                    ? "underline underline-offset-2 cursor-pointer"
	                    : "opacity-75 hover:opacity-100 hover:text-bb-accent cursor-pointer"
	                }
	              >
	                {label}
	              </button>
	            )}
	          </For>
	          <button
	            type="button"
	            data-testid="nav-menu"
	            onClick={() => setShowPalette(true)}
	            class="opacity-75 hover:opacity-100 hover:text-bb-accent cursor-pointer"
	            title="All views (Ctrl+K)"
	          >
	            [MENU]
	          </button>
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
	    </div>
	  );
	}

export default App;
