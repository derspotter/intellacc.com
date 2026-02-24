import { createSignal, Show } from 'solid-js';
import { createPost, uploadPostImage } from '../../services/api';

const MAX_PREVIEW_SIZE = 4_000_000;

export default function CreatePostForm(props) {
  const [content, setContent] = createSignal('');
  const [attachment, setAttachment] = createSignal(null);
  const [previewUrl, setPreviewUrl] = createSignal(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');

  const clearAttachment = () => {
    const current = attachment();
    const currentPreview = previewUrl();
    if (currentPreview) {
      URL.revokeObjectURL(currentPreview);
    }
    setAttachment(null);
    setPreviewUrl(null);
    const input = document.getElementById('solid-post-attachment');
    if (input) {
      input.value = '';
    }
  };

  const handleFileChange = (event) => {
    const file = event.target?.files?.[0];
    if (!file) {
      clearAttachment();
      return;
    }

    if (!file.type.startsWith('image/')) {
      setError('Only image files are supported.');
      clearAttachment();
      return;
    }

    if (file.size > MAX_PREVIEW_SIZE) {
      setError('File is too large. Limit is 4MB.');
      clearAttachment();
      return;
    }

    const preview = URL.createObjectURL(file);
    clearAttachment();
    setAttachment(file);
    setPreviewUrl(preview);
    setError('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const text = content().trim();
    if (!text) {
      setError('Post content cannot be empty.');
      return;
    }

    try {
      setSubmitting(true);
      setError('');
      let imageAttachmentId = null;
      if (attachment()) {
        const uploaded = await uploadPostImage(attachment());
        imageAttachmentId = uploaded?.attachmentId || null;
      }
      const post = await createPost(text, imageAttachmentId, null);
      setContent('');
      clearAttachment();
      props.onCreated?.(post);
    } catch (err) {
      setError(err?.message || 'Failed to create post.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section class="create-post-card">
      <form onSubmit={handleSubmit}>
        <div class="form-group">
          <label for="solid-post-content" class="sr-only">
            Post content
          </label>
          <textarea
          id="solid-post-content"
          value={content()}
          class="comment-input"
          onInput={(event) => setContent(event.target.value)}
          placeholder="Share a thought..."
          rows={4}
          disabled={submitting()}
          />
        </div>
        <div class="create-post-attachments">
          <div class="file-row">
            <button
              type="button"
              class="file-button"
              onClick={() => {
                const input = document.getElementById('solid-post-attachment');
                input?.click();
              }}
            >
              {attachment() ? 'Change File' : 'Browse...'}
            </button>
            <input
              id="solid-post-attachment"
              type="file"
              class="file-input"
              accept="image/*"
              onChange={handleFileChange}
              disabled={submitting()}
            />
            <Show when={attachment()}>
              <span class="file-name">{attachment().name}</span>
            </Show>
            <Show when={attachment()}>
              <button type="button" class="attachment-remove" onClick={clearAttachment}>
                Remove
              </button>
            </Show>
          </div>
        </div>
        <Show when={previewUrl()}>
          <div class="attachment-preview">
            <img src={previewUrl()} alt="Image preview" />
            <button type="button" class="attachment-remove" onClick={clearAttachment}>
              Remove
            </button>
          </div>
        </Show>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <div class="form-actions">
          <button type="submit" class="post-action submit-button" disabled={submitting()}>
            {submitting() ? 'Posting…' : 'Post'}
          </button>
        </div>
      </form>
    </section>
  );
}
