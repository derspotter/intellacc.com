import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { requestBlob } from '../../services/api';

export default function PostItem(props) {
  const post = props.post;
  const hasAttachment = !!post.image_attachment_id;
  const [attachmentSrc, setAttachmentSrc] = createSignal(null);

  const author = () => post.username || `user-${post.user_id || 'unknown'}`;
  const meta = createMemo(() => {
    const date = post.created_at ? new Date(post.created_at).toLocaleString() : '';
    return `${post.like_count || 0} likes · ${date}`;
  });

  const resolveAttachmentSrc = () => {
    if (!hasAttachment) {
      return null;
    }

    return `/attachments/${post.image_attachment_id}`;
  };

  onMount(() => {
    const src = resolveAttachmentSrc();
    if (!src) {
      return;
    }

    requestBlob(src)
      .then((blob) => {
        const nextUrl = URL.createObjectURL(blob);
        setAttachmentSrc(nextUrl);
      })
      .catch((error) => {
        console.error('Failed to load post attachment', error);
      });
  });

  onCleanup(() => {
    const current = attachmentSrc();
    if (current) {
      URL.revokeObjectURL(current);
    }
  });

  return (
    <article class="feed-item">
      <header class="feed-item-header">
        <h2>{author()}</h2>
        <span class="meta">{meta()}</span>
      </header>
      <p>{post.content || 'No content'}</p>
      <Show when={post.ai_is_flagged}>
        <p class="ai-warning">AI-flagged content</p>
      </Show>
      <Show when={attachmentSrc()}>
        <img src={attachmentSrc()} alt="" class="post-attachment" />
      </Show>
      <p class="meta">posted by {author()}</p>
    </article>
  );
}
