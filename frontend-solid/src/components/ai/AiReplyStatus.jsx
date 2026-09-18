import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { getCurrentUserId } from '../../services/auth';
import { aiApi } from '../../services/api';

export default function AiReplyStatus(props) {
  const [status, setStatus] = createSignal(null);
  createEffect(() => {
    const post = props.post;
    setStatus(null);
    if (!post?.id || post.is_temp || post.is_bot || String(post.user_id) !== getCurrentUserId()
      || !/(?:^|[\s([{])@ai\b/i.test(post.content || '')) return;
    let stopped = false;
    let timer;
    let attempts = 0;
    const check = async () => {
      try {
        const result = await aiApi.publicReply(post.id);
        if (stopped) return;
        setStatus(result);
        if (['queued', 'running'].includes(result?.status) && ++attempts < 60) timer = setTimeout(check, 5000);
      } catch {
        // Older posts mentioning @ai do not necessarily have a job.
      }
    };
    void check();
    onCleanup(() => { stopped = true; clearTimeout(timer); });
  });
  return <Show when={status()}>
    <div class="ai-reply-status" role="status">
      <Show when={status()?.status === 'published'} fallback={
        status()?.reason || (status()?.status === 'running' ? 'AI is preparing a public reply…' : 'AI reply queued…')
      }>
        <a href={`#post/${status()?.replyPostId}`}>View AI reply</a>
      </Show>
    </div>
  </Show>;
}
