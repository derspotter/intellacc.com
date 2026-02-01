// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EditPostForm from '../src/components/posts/EditPostForm.js';
import postsStore from '../src/store/posts.js';

describe('EditPostForm legacy image_url removal', () => {
  let originalUpdatePost;
  let originalUploadPostImage;
  let originalEnsureAttachmentUrl;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;

  beforeEach(() => {
    originalUpdatePost = postsStore.actions.updatePost;
    originalUploadPostImage = postsStore.actions.uploadPostImage;
    originalEnsureAttachmentUrl = postsStore.actions.ensureAttachmentUrl;
    originalCreateObjectURL = global.URL?.createObjectURL;
    originalRevokeObjectURL = global.URL?.revokeObjectURL;

    postsStore.actions.updatePost = vi.fn().mockResolvedValue({});
    postsStore.actions.uploadPostImage = vi.fn().mockResolvedValue({ attachmentId: 123 });
    postsStore.actions.ensureAttachmentUrl = vi.fn().mockResolvedValue('blob:legacy');

    if (!global.URL) global.URL = {};
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:new');
    global.URL.revokeObjectURL = vi.fn();

    document.body.innerHTML = '';
  });

  afterEach(() => {
    postsStore.actions.updatePost = originalUpdatePost;
    postsStore.actions.uploadPostImage = originalUploadPostImage;
    postsStore.actions.ensureAttachmentUrl = originalEnsureAttachmentUrl;
    if (originalCreateObjectURL) {
      global.URL.createObjectURL = originalCreateObjectURL;
    } else {
      delete global.URL.createObjectURL;
    }
    if (originalRevokeObjectURL) {
      global.URL.revokeObjectURL = originalRevokeObjectURL;
    } else {
      delete global.URL.revokeObjectURL;
    }
    document.body.innerHTML = '';
  });

  it('clears legacy image_url when removing image without new upload', async () => {
    const post = {
      id: 1,
      content: 'Legacy image post',
      image_url: 'https://example.com/legacy.png',
      image_attachment_id: null
    };

    const onCancel = vi.fn();
    const form = EditPostForm({ post, onCancel });
    document.body.appendChild(form);

    const removeButton = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent === 'Remove');
    expect(removeButton).toBeTruthy();
    removeButton.click();

    const submitForm = document.querySelector('form.edit-form');
    submitForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(postsStore.actions.updatePost).toHaveBeenCalledTimes(1);
    const [, , options] = postsStore.actions.updatePost.mock.calls[0];
    expect(options).toEqual({ image_attachment_id: null, image_url: null });
  });

  it('clears legacy image_url when replacing with new attachment', async () => {
    const post = {
      id: 2,
      content: 'Legacy image post',
      image_url: 'https://example.com/legacy.png',
      image_attachment_id: null
    };

    const onCancel = vi.fn();
    const form = EditPostForm({ post, onCancel });
    document.body.appendChild(form);

    const fileInput = document.querySelector('input[type="file"]');
    const file = new File(['data'], 'new.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    const submitForm = document.querySelector('form.edit-form');
    submitForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(postsStore.actions.uploadPostImage).toHaveBeenCalledTimes(1);
    expect(postsStore.actions.updatePost).toHaveBeenCalledTimes(1);
    const [, , options] = postsStore.actions.updatePost.mock.calls[0];
    expect(options).toEqual({ image_attachment_id: 123, image_url: null });
  });
});
