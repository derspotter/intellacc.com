// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ProfileEditor from '../src/components/profile/ProfileEditor.js';
import userStore from '../src/store/user.js';

describe('ProfileEditor username update', () => {
  let originalUpdateUserProfile;
  let originalProfile;

  beforeEach(() => {
    originalUpdateUserProfile = userStore.actions.updateUserProfile;
    originalProfile = userStore.state.profile.val;

    userStore.state.profile.val = {
      id: 1,
      username: 'OldName',
      bio: 'Old bio'
    };

    userStore.actions.updateUserProfile = vi.fn().mockResolvedValue(true);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    userStore.actions.updateUserProfile = originalUpdateUserProfile;
    userStore.state.profile.val = originalProfile;
    document.body.innerHTML = '';
  });

  it('submits trimmed username and bio payload', async () => {
    const onCancel = vi.fn();
    const editor = ProfileEditor({ onCancel });
    document.body.appendChild(editor);

    const usernameInput = document.getElementById('profile-username-input');
    const bioTextarea = document.getElementById('profile-bio-textarea');

    usernameInput.value = '  NewName  ';
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    bioTextarea.value = 'New bio';
    bioTextarea.dispatchEvent(new Event('input', { bubbles: true }));

    const saveButton = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent === 'Save Profile');
    expect(saveButton).toBeTruthy();
    saveButton.click();

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(userStore.actions.updateUserProfile).toHaveBeenCalledTimes(1);
    expect(userStore.actions.updateUserProfile).toHaveBeenCalledWith({
      bio: 'New bio',
      username: 'NewName'
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows error when username is empty', async () => {
    userStore.state.profile.val = {
      ...userStore.state.profile.val,
      username: ''
    };
    const onCancel = vi.fn();
    const editor = ProfileEditor({ onCancel });
    document.body.appendChild(editor);

    const usernameInput = document.getElementById('profile-username-input');
    usernameInput.value = '';
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));

    const saveButton = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent === 'Save Profile');
    expect(saveButton).toBeTruthy();
    if (typeof saveButton.onclick === 'function') {
      saveButton.onclick();
    } else {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    const waitFor = async (predicate, attempts = 5) => {
      for (let i = 0; i < attempts; i += 1) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    };

    await waitFor(() => document.querySelector('.error-message')?.textContent === 'Username cannot be empty');

    expect(userStore.actions.updateUserProfile).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    const errorEl = document.querySelector('.error-message');
    expect(errorEl).toBeTruthy();
    expect(errorEl.textContent).toBe('Username cannot be empty');
  });

  it('shows error when username is already taken', async () => {
    userStore.actions.updateUserProfile = vi.fn().mockImplementation(() => {
      userStore.state.error.val = 'Username is already taken';
      return Promise.resolve(false);
    });

    const onCancel = vi.fn();
    const editor = ProfileEditor({ onCancel });
    document.body.appendChild(editor);

    const usernameInput = document.getElementById('profile-username-input');
    usernameInput.value = 'ExistingName';
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));

    const saveButton = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent === 'Save Profile');
    expect(saveButton).toBeTruthy();
    if (typeof saveButton.onclick === 'function') {
      saveButton.onclick();
    } else {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    const waitFor = async (predicate, attempts = 5) => {
      for (let i = 0; i < attempts; i += 1) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    };

    await waitFor(() => document.querySelector('.error-message')?.textContent === 'Username is already taken');

    expect(userStore.actions.updateUserProfile).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    const errorEl = document.querySelector('.error-message');
    expect(errorEl).toBeTruthy();
    expect(errorEl.textContent).toBe('Username is already taken');
  });
});
