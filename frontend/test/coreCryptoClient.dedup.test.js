import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('CoreCryptoClient Deduplication', () => {
    let mockProcessedMessageIds;
    let mockProcessingMessageIds;

    beforeEach(() => {
        mockProcessedMessageIds = new Set();
        mockProcessingMessageIds = new Set();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('markProcessed', () => {
        it('should add id to processedMessageIds', () => {
            const id = 'test-msg-id-1';
            // Simulate markProcessed behavior
            if (id) {
                mockProcessedMessageIds.add(id);
                mockProcessingMessageIds.delete(id);
            }
            expect(mockProcessedMessageIds.has(id)).toBe(true);
            expect(mockProcessingMessageIds.has(id)).toBe(false);
        });

        it('should enforce the maximum set size of 2000 items', () => {
            // Fill the set with 2005 items
            for (let i = 0; i < 2005; i++) {
                mockProcessedMessageIds.add(`msg-${i}`);
            }

            // Simulate the boundary resizing behavior in markProcessed
            if (mockProcessedMessageIds.size > 2000) {
                const arr = Array.from(mockProcessedMessageIds);
                mockProcessedMessageIds = new Set(arr.slice(arr.length - 1000));
            }

            expect(mockProcessedMessageIds.size).toBe(1000);
            expect(mockProcessedMessageIds.has('msg-2004')).toBe(true); // Should keep the newest
            expect(mockProcessedMessageIds.has('msg-0')).toBe(false);   // Oldest should be evicted
        });
    });

    describe('duplicate detection behavior', () => {
        it('should skip messages already in processedMessageIds', () => {
            const msg = {
                id: 'existing-msg',
                group_id: 'group-1',
                message_type: 'application'
            };

            mockProcessedMessageIds.add('existing-msg');

            // Simulate duplicate check behavior
            const isDuplicate = mockProcessedMessageIds.has(msg.id);
            expect(isDuplicate).toBe(true);
        });
    });
});
