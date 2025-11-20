import { describe, it, expect, beforeEach } from 'vitest';
import messagingStore from '../src/stores/messagingStore.js';

describe('messagingStore meta + unread', () => {
  beforeEach(() => {
    // Reset store state
    messagingStore.clearCache();
    messagingStore.messagesMeta = {};
    messagingStore.eventsMeta = {};
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

  it('markConversationStale forces next refresh', () => {
    const convId = 2;
    messagingStore.updateMessagesMeta(convId, { lastFetchedTs: Date.now() });
    messagingStore.markConversationStale(convId);
    expect(messagingStore.messagesMeta[String(convId)].lastFetchedTs).toBe(0);
  });

  it('incrementUnread updates my_unread_count based on currentUserId', () => {
    // Seed a conversation with participant_1 = current user
    messagingStore.upsertConversations([{ id: 3, participant_1: 1001, participant_2: 1002, created_at: new Date().toISOString() }]);
    const before = messagingStore.conversations.find(c => String(c.id) === '3');
    messagingStore.incrementUnread(3, 1);
    const after = messagingStore.conversations.find(c => String(c.id) === '3');
    expect(after.my_unread_count).toBe((before.my_unread_count || 0) + 1);
  });

  it('ackPendingMessage reconciles pending by clientId and preserves decrypted content', () => {
    const convId = 10;
    const clientId = 'abc123';
    const pending = {
      id: `c:${clientId}`,
      clientId,
      conversation_id: convId,
      sender_id: 1001,
      receiver_id: 1002,
      created_at: new Date().toISOString(),
      decryptedContent: 'hello pending',
      isDecrypted: true,
      status: 'pending'
    };
    messagingStore.setMessages(convId, [pending]);

    const serverMessage = {
      id: 555,
      conversation_id: convId,
      sender_id: 1001,
      receiver_id: 1002,
      created_at: new Date().toISOString(),
      encrypted_content: 'enc',
    };

    const updated = messagingStore.ackPendingMessage(convId, clientId, serverMessage);
    expect(updated).toBe(true);
    const msgs = messagingStore.messagesByConversation[String(convId)];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(555);
    expect(msgs[0].status).toBe('sent');
    expect(msgs[0].clientId).toBe(clientId);
    // Still preserves prior decrypted content for immediate UX
    expect(msgs[0].decryptedContent).toBe('hello pending');
  });

  it('ackPendingMessage inserts when no pending exists', () => {
    const convId = 11;
    messagingStore.setMessages(convId, []);
    const serverMessage = { id: 777, conversation_id: convId, sender_id: 1001, receiver_id: 1002, created_at: new Date().toISOString() };
    const res = messagingStore.ackPendingMessage(convId, 'nope', serverMessage);
    expect(res).toBe(true);
    const msgs = messagingStore.messagesByConversation[String(convId)];
    expect(msgs.find(m => m.id === 777)).toBeTruthy();
  });
});
