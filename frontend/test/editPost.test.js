import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import van from 'vanjs-core';
import postsStore from '../src/store/posts';
import authStore from '../src/store/auth';
import api from '../src/services/api';
import PostItem from '../src/components/posts/PostItem';
import EditPostForm from '../src/components/posts/EditPostForm';

// Mock the API
vi.mock('../src/services/api', () => ({
  default: {
    posts: {
      update: vi.fn()
    }
  }
}));

describe('Edit Post Functionality', () => {
  beforeEach(() => {
    // Reset all mocks and stores
    vi.clearAllMocks();
    
    // Reset store states
    postsStore.postsState.val = [];
    postsStore.editingPostId.val = null;
    authStore.userProfileState.val = { id: 1, username: 'testuser' };
  });

  afterEach(() => {
    // Clean up DOM
    document.body.innerHTML = '';
  });

  describe('PostItem Edit Button', () => {
    it('should show edit button for post owner', () => {
      const mockPost = {
        id: 1,
        user_id: 1, // Same as authenticated user
        content: 'Test post content',
        username: 'testuser',
        created_at: '2024-01-01T00:00:00Z'
      };

      const postItem = PostItem(mockPost);
      document.body.appendChild(postItem);

      const editButton = document.querySelector('[data-testid="edit-post-btn"]');
      expect(editButton).toBeTruthy();
    });

    it('should not show edit button for posts by other users', () => {
      const mockPost = {
        id: 1,
        user_id: 2, // Different from authenticated user
        content: 'Test post content',
        username: 'otheruser',
        created_at: '2024-01-01T00:00:00Z'
      };

      const postItem = PostItem(mockPost);
      document.body.appendChild(postItem);

      const editButton = document.querySelector('[data-testid="edit-post-btn"]');
      expect(editButton).toBeFalsy();
    });

    it('should enter edit mode when edit button is clicked', () => {
      const mockPost = {
        id: 1,
        user_id: 1,
        content: 'Test post content',
        username: 'testuser',
        created_at: '2024-01-01T00:00:00Z'
      };

      const postItem = PostItem(mockPost);
      document.body.appendChild(postItem);

      const editButton = document.querySelector('[data-testid="edit-post-btn"]');
      editButton.click();

      expect(postsStore.editingPostId.val).toBe(1);
    });

    it('should show EditPostForm when in edit mode', () => {
      const mockPost = {
        id: 1,
        user_id: 1,
        content: 'Test post content',
        username: 'testuser',
        created_at: '2024-01-01T00:00:00Z'
      };

      // Set edit mode
      postsStore.editingPostId.val = 1;

      const postItem = PostItem(mockPost);
      document.body.appendChild(postItem);

      const editForm = document.querySelector('[data-testid="edit-post-form"]');
      expect(editForm).toBeTruthy();
    });
  });

  describe('Posts Store updatePost Action', () => {
    it('should call API and update post optimistically', async () => {
      const mockPost = {
        id: 1,
        user_id: 1,
        content: 'Original content',
        username: 'testuser',
        created_at: '2024-01-01T00:00:00Z'
      };

      const updatedPost = {
        ...mockPost,
        content: 'Updated content'
      };

      // Setup initial state
      postsStore.postsState.val = [mockPost];

      // Mock successful API response
      api.posts.update.mockResolvedValueOnce(updatedPost);

      // Call updatePost action
      await postsStore.actions.updatePost(1, { content: 'Updated content' });

      // Verify API was called correctly
      expect(api.posts.update).toHaveBeenCalledWith(1, { content: 'Updated content' });

      // Verify post was updated in store
      expect(postsStore.postsState.val[0].content).toBe('Updated content');

      // Verify editing mode is cleared
      expect(postsStore.editingPostId.val).toBe(null);
    });

    it('should handle API errors gracefully', async () => {
      const mockPost = {
        id: 1,
        user_id: 1,
        content: 'Original content',
        username: 'testuser',
        created_at: '2024-01-01T00:00:00Z'
      };

      // Setup initial state
      postsStore.postsState.val = [mockPost];
      postsStore.editingPostId.val = 1;

      // Mock API error
      const errorResponse = new Error('Not authorized');
      errorResponse.response = { status: 403, data: { error: 'Not authorized to update this post' } };
      api.posts.update.mockRejectedValueOnce(errorResponse);

      // Call updatePost action
      await postsStore.actions.updatePost(1, { content: 'Updated content' });

      // Verify post was not updated in store
      expect(postsStore.postsState.val[0].content).toBe('Original content');

      // Verify editing mode is cleared
      expect(postsStore.editingPostId.val).toBe(null);
    });

    it('should prevent multiple posts from being edited simultaneously', () => {
      // Set first post in edit mode
      postsStore.editingPostId.val = 1;

      // Try to start editing another post
      postsStore.actions.startEditingPost(2);

      // Should remain on first post
      expect(postsStore.editingPostId.val).toBe(1);
    });

    it('should cancel edit mode when cancelEditingPost is called', () => {
      postsStore.editingPostId.val = 1;

      postsStore.actions.cancelEditingPost();

      expect(postsStore.editingPostId.val).toBe(null);
    });
  });

  describe('EditPostForm Component', () => {
    it('should initialize with current post content', () => {
      const mockPost = {
        id: 1,
        content: 'Current post content',
        image_url: 'https://example.com/image.jpg'
      };

      const editForm = EditPostForm(mockPost, vi.fn(), vi.fn());
      document.body.appendChild(editForm);

      const contentTextarea = document.querySelector('[data-testid="edit-content-textarea"]');
      const imageInput = document.querySelector('[data-testid="edit-image-input"]');

      expect(contentTextarea.value).toBe('Current post content');
      expect(imageInput.value).toBe('https://example.com/image.jpg');
    });

    it('should call onSave with updated data when save is clicked', () => {
      const mockPost = {
        id: 1,
        content: 'Original content',
        image_url: ''
      };

      const onSave = vi.fn();
      const onCancel = vi.fn();

      const editForm = EditPostForm(mockPost, onSave, onCancel);
      document.body.appendChild(editForm);

      // Update content
      const contentTextarea = document.querySelector('[data-testid="edit-content-textarea"]');
      contentTextarea.value = 'Updated content';
      contentTextarea.dispatchEvent(new Event('input'));

      // Click save
      const saveButton = document.querySelector('[data-testid="save-edit-btn"]');
      saveButton.click();

      expect(onSave).toHaveBeenCalledWith({
        content: 'Updated content',
        image_url: ''
      });
    });

    it('should call onCancel when cancel is clicked', () => {
      const mockPost = {
        id: 1,
        content: 'Content',
        image_url: ''
      };

      const onSave = vi.fn();
      const onCancel = vi.fn();

      const editForm = EditPostForm(mockPost, onSave, onCancel);
      document.body.appendChild(editForm);

      const cancelButton = document.querySelector('[data-testid="cancel-edit-btn"]');
      cancelButton.click();

      expect(onCancel).toHaveBeenCalled();
    });

    it('should not allow saving empty content', () => {
      const mockPost = {
        id: 1,
        content: 'Original content',
        image_url: ''
      };

      const onSave = vi.fn();
      const onCancel = vi.fn();

      const editForm = EditPostForm(mockPost, onSave, onCancel);
      document.body.appendChild(editForm);

      // Clear content
      const contentTextarea = document.querySelector('[data-testid="edit-content-textarea"]');
      contentTextarea.value = '';
      contentTextarea.dispatchEvent(new Event('input'));

      // Try to save
      const saveButton = document.querySelector('[data-testid="save-edit-btn"]');
      saveButton.click();

      expect(onSave).not.toHaveBeenCalled();
      expect(saveButton.disabled).toBe(true);
    });
  });
});
