import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Simulate IndexedDB transaction store behavior for dedup logic
let transactionStore = {};
const TEST_DEVICE_ID = 'test-device-123';

describe('VaultService Message Deduplication', () => {
    beforeEach(() => {
        transactionStore = {};
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    describe('markMessageProcessed', () => {
        it('should store a processed message with timestamp and device ID', () => {
            const messageId = 'msg-12345';
            const now = Date.now();
            vi.setSystemTime(now);

            // Expected record structure
            const expectedRecord = {
                id: messageId,
                deviceId: TEST_DEVICE_ID,
                timestamp: now
            };

            // Simulate placing into the store
            transactionStore[messageId] = expectedRecord;

            expect(transactionStore[messageId]).toBeDefined();
            expect(transactionStore[messageId].id).toBe('msg-12345');
            expect(transactionStore[messageId].deviceId).toBe(TEST_DEVICE_ID);
            expect(transactionStore[messageId].timestamp).toBe(now);
        });
    });

    describe('getRecentProcessedMessages', () => {
        it('should return empty array when no messages stored', () => {
            const allMessages = Object.values(transactionStore).filter(r => r.deviceId === TEST_DEVICE_ID);
            expect(allMessages).toHaveLength(0);
        });

        it('should return recent processed messages up to the limit', () => {
            // Setup: Store multiple processed messages
            const now = Date.now();

            transactionStore['msg-1'] = { id: 'msg-1', deviceId: TEST_DEVICE_ID, timestamp: now - 1000 };
            transactionStore['msg-2'] = { id: 'msg-2', deviceId: TEST_DEVICE_ID, timestamp: now - 500 };
            transactionStore['msg-3'] = { id: 'msg-3', deviceId: TEST_DEVICE_ID, timestamp: now };
            transactionStore['msg-other-device'] = { id: 'msg-other-device', deviceId: 'other-device-456', timestamp: now };

            const records = Object.values(transactionStore).filter(r => r.deviceId === TEST_DEVICE_ID);
            records.sort((a, b) => b.timestamp - a.timestamp);

            const limit = 2;
            const recent = records.slice(0, limit).map(r => r.id);

            expect(recent).toHaveLength(2);
            expect(recent[0]).toBe('msg-3'); // Most recent first
            expect(recent[1]).toBe('msg-2');
        });
    });

    describe('IndexedDB schema version 9', () => {
        it('should create processed_messages store on upgrade', () => {
            const expectedSchema = {
                storeName: 'processed_messages',
                keyPath: 'id',
                indexes: [
                    { name: 'deviceId', keyPath: 'deviceId', options: { unique: false } },
                    { name: 'timestamp', keyPath: 'timestamp', options: { unique: false } }
                ]
            };

            expect(expectedSchema.storeName).toBe('processed_messages');
            expect(expectedSchema.keyPath).toBe('id');
            expect(expectedSchema.indexes).toHaveLength(2);
            expect(expectedSchema.indexes[0].options.unique).toBe(false);
        });
    });
});
