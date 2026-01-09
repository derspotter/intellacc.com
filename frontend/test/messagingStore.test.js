import { describe, it, expect, beforeEach } from 'vitest';
import messagingStore from '../src/stores/messagingStore.js';

describe('messagingStore meta + unread', () => {
  beforeEach(() => {
    // Reset store state
    messagingStore.clearCache();
    messagingStore.messagesMeta = {};
    messagingStore.messagesByConversation = {};
    messagingStore.conversations = [];
    messagingStore.conversationsById = {};
    messagingStore.currentUserId = 1001;
  });

  it('setMessages updates lastFetchedTs and messagesByConversation', () => {
    const convId = 1;
    const msgs = [
      { id: 10, created_at: '2025-09-07T12:00:00.000Z' },
      { id: 11, created_at: '2025-09-07T12:01:00.000Z' }
    ];
    messagingStore.setMessages(convId, msgs);
    expect(messagingStore.messagesByConversation[convId]).toHaveLength(2);
    expect(messagingStore.messagesMeta[String(convId)].lastFetchedTs).toBeTypeOf('number');
  });

  it('setMessages creates meta entry with lastFetchedTs', () => {
    const convId = 2;
    const msgs = [{ id: 20, created_at: '2025-09-07T12:00:00.000Z' }];
    const beforeTs = Date.now();
    messagingStore.setMessages(convId, msgs);
    const afterTs = Date.now();

    const meta = messagingStore.messagesMeta[String(convId)];
    expect(meta).toBeDefined();
    expect(meta.lastFetchedTs).toBeGreaterThanOrEqual(beforeTs);
    expect(meta.lastFetchedTs).toBeLessThanOrEqual(afterTs);
  });

  it('incrementUnread updates unread count for conversation', () => {
    // Setup: seed a conversation directly with numeric ID (matching incrementUnread's expected type)
    // We need to set up the token for incrementUnread to work
    const mockToken = btoa(JSON.stringify({ userId: 1001 }));
    const origToken = localStorage.getItem('token');
    localStorage.setItem('token', `header.${mockToken}.signature`);

    try {
      // Directly populate store with a conversation that has numeric id
      // (incrementUnread uses strict equality with the id parameter)
      messagingStore.conversations = [{
        id: 3,  // numeric to match incrementUnread(3, 1) call
        participant_1: 1001,
        participant_2: 1002,
        created_at: new Date().toISOString(),
        my_unread_count: 0
      }];

      const before = messagingStore.conversations.find(c => c.id === 3);
      const beforeUnread = before?.my_unread_count || 0;

      messagingStore.incrementUnread(3, 1);

      const after = messagingStore.conversations.find(c => c.id === 3);
      if (!after) {
        throw new Error('Conversation not found after incrementUnread');
      }
      expect(after.my_unread_count).toBe(beforeUnread + 1);
    } finally {
      // Restore original token
      if (origToken) {
        localStorage.setItem('token', origToken);
      } else {
        localStorage.removeItem('token');
      }
    }
  });

  it('addMessage inserts new message and avoids duplicates', () => {
    const convId = 10;
    messagingStore.setMessages(convId, []);

    const message1 = {
      id: 100,
      conversation_id: convId,
      sender_id: 1001,
      receiver_id: 1002,
      created_at: new Date().toISOString(),
      content: 'hello'
    };

    // Add first message
    messagingStore.addMessage(convId, message1);
    expect(messagingStore.messagesByConversation[convId]).toHaveLength(1);
    expect(messagingStore.messagesByConversation[convId][0].id).toBe(100);

    // Try to add duplicate - should not add
    messagingStore.addMessage(convId, message1);
    expect(messagingStore.messagesByConversation[convId]).toHaveLength(1);
  });

  it('addMessage inserts messages in chronological order', () => {
    const convId = 11;
    messagingStore.setMessages(convId, []);

    const message1 = { id: 1, created_at: '2025-01-01T12:00:00Z' };
    const message3 = { id: 3, created_at: '2025-01-01T14:00:00Z' };
    const message2 = { id: 2, created_at: '2025-01-01T13:00:00Z' };

    messagingStore.addMessage(convId, message1);
    messagingStore.addMessage(convId, message3);
    messagingStore.addMessage(convId, message2); // Should insert between 1 and 3

    const msgs = messagingStore.messagesByConversation[convId];
    expect(msgs).toHaveLength(3);
    expect(msgs[0].id).toBe(1);
    expect(msgs[1].id).toBe(2);
    expect(msgs[2].id).toBe(3);
  });
});
