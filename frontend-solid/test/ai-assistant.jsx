import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import AiDrawer from '../src/components/ai/AiDrawer';
import AiSettings from '../src/components/ai/AiSettings';
import PostItem from '../src/components/posts/PostItem';
import TerminalPost from '../src/components/terminal/PostItem';
import MessagesPage from '../src/pages/MessagesPage';
import { ChatPanel } from '../src/components/ChatPanel';
import { clearToken } from '../src/services/tokenService';
import '../src/styles.css';
import '../src/index.css';

const terminal = new URLSearchParams(location.search).has('terminal');
document.body.classList.add(terminal ? 'skin-terminal' : 'skin-van');
const [route, setRoute] = createSignal(location.hash);
window.addEventListener('hashchange', () => setRoute(location.hash));
const post = { id: 10, content: 'Will renewable energy reach 50% of global electricity by 2035?', username: 'forecaster', user_id: 9, created_at: '2026-09-18T10:00:00Z', comment_count: 0 };

render(() => <>
  <div style={{ padding: '24px', 'max-width': '900px', margin: 'auto' }}>
    <button type="button" onClick={clearToken}>Log out fixture</button>
    <Show when={route() === '#settings'} fallback={
      <Show when={route() === '#messages'} fallback={
        <Show when={terminal} fallback={<PostItem post={post} />}><TerminalPost post={post} disableFeedStore /></Show>
      }>
        <div style={{ height: '700px' }}><Show when={terminal} fallback={<MessagesPage />}><ChatPanel /></Show></div>
      </Show>
    }><AiSettings /></Show>
  </div>
  <AiDrawer />
</>, document.getElementById('fixture'));
