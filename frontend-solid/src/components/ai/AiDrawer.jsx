import { createEffect, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { getCurrentUserId } from '../../services/auth';
import { isLoggedIn } from '../../services/tokenService';
import ai from '../../store/aiStore';
import AiConversation from './AiConversation';

export default function AiDrawer() {
  let closeButton;
  createEffect(() => ai.resetForUser(getCurrentUserId()));
  createEffect(() => {
    if (!ai.state.open) return;
    closeButton?.focus();
    const escape = (event) => { if (event.key === 'Escape') { event.preventDefault(); ai.close(); } };
    window.addEventListener('keydown', escape);
    onCleanup(() => window.removeEventListener('keydown', escape));
  });
  const notice = (event) => ai.setNotice(String(event.detail || ''));
  window.addEventListener('ai-notice', notice);
  onCleanup(() => window.removeEventListener('ai-notice', notice));
  return (
    <Portal>
      <Show when={isLoggedIn()}>
        <Show when={ai.state.notice}>
          <div class="ai-toast" role="status">
            <span>{ai.state.notice}</span>
            <button type="button" aria-label="Dismiss AI notice" onClick={() => ai.setNotice('')}>×</button>
          </div>
        </Show>
        <Show when={!ai.state.open}>
          <button type="button" class="ai-launcher" aria-label="Open private AI chat" aria-haspopup="dialog" onClick={() => ai.open()}>✧ AI</button>
        </Show>
        <Show when={ai.state.open}>
          <section class="ai-drawer" role="dialog" aria-modal="false" aria-label="AI assistant">
            <header class="ai-drawer-header">
              <div><strong>✧ AI</strong><span>Private conversation</span></div>
              <div class="ai-header-actions">
                <a href="#messages" onClick={() => { ai.showDm(); ai.close(); }}>Messages</a>
                <button type="button" ref={closeButton} aria-label="Close AI panel" onClick={() => ai.close()}>×</button>
              </div>
            </header>
            <AiConversation drawer />
          </section>
        </Show>
      </Show>
    </Portal>
  );
}
