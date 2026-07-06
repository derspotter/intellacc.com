import { Show, Suspense } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { TERMINAL_VIEWS } from './views/registry';

// Full-screen layer over the panes (below the tmux top bar). Closing always
// routes back to #home so the hash stays the single source of truth.
export const closeTerminalView = () => {
  window.location.hash = '#home';
};

export const TerminalViewHost = (props) => {
  const view = () => TERMINAL_VIEWS[props.viewKey];

  return (
    <Show when={view()}>
      {/* z-[55]: must beat pane internals (chat sidebar z-40, resize handles z-50);
          the command palette lives in a sibling z-[60] layer and stays on top. */}
      <div class="absolute inset-0 z-[55] bg-bb-bg flex flex-col" data-view={props.viewKey}>
        <div class="shrink-0 h-8 flex items-center justify-between px-3 bg-bb-panel border-b border-bb-border font-mono text-xs select-none">
          <span class="text-bb-accent font-bold">[VIEW] {view().title}</span>
          <button
            type="button"
            class="text-bb-muted hover:text-bb-accent cursor-pointer"
            onClick={closeTerminalView}
          >
            [X] ESC TO CLOSE
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          <Suspense fallback={<div class="p-4 text-bb-muted font-mono animate-pulse">LOADING VIEW...</div>}>
            <Dynamic component={view().component} param={props.param} />
          </Suspense>
        </div>
      </div>
    </Show>
  );
};
