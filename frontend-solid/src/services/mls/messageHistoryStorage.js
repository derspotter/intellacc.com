const STORE = 'encrypted_messages';

export const messageIndexFields = (record) => ({
  ...record,
  groupId: String(record.groupId),
  messageKey: String(record.messageId),
  sortTime: Number.isFinite(new Date(record.timestamp).getTime()) ? new Date(record.timestamp).getTime() : 0
});

// Upgrade ciphertext records without decrypting or requiring an unlocked vault.
export function upgradeMessageHistory(store) {
  if (!store.indexNames.contains('deviceGroupOrder')) {
    store.createIndex('deviceGroupOrder', ['deviceId', 'groupId', 'sortTime', 'id']);
  }
  if (!store.indexNames.contains('deviceGroupMessage')) {
    store.createIndex('deviceGroupMessage', ['deviceId', 'groupId', 'messageKey']);
  }
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.update(messageIndexFields(cursor.value));
    cursor.continue();
  };
}

export function captureSession(vault) {
  if (!vault.compositeKey || !vault.deviceId) throw new Error('Vault locked');
  return { key: vault.compositeKey, deviceId: vault.deviceId, epoch: vault.historyEpoch };
}

export function assertSession(vault, session) {
  if (vault.compositeKey !== session.key || vault.deviceId !== session.deviceId || vault.historyEpoch !== session.epoch) {
    throw new Error('Vault locked');
  }
}

async function decodeRecords(vault, records, session, signal) {
  const messages = new Array(records.length);
  const expiredKeys = [];
  let next = 0;
  // Bound crypto work as well as the number of records read from IndexedDB.
  await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
    while (next < records.length) {
      signal?.throwIfAborted();
      assertSession(vault, session);
      const index = next++;
      const record = records[index];
      try {
        const payload = await vault._decryptMessagePayload(record, session);
        signal?.throwIfAborted();
        if (payload.expiresAt && Number(payload.expiresAt) <= Date.now()) {
          expiredKeys.push(record.id);
          continue;
        }
        messages[index] = {
          id: record.messageId, groupId: record.groupId, timestamp: record.timestamp,
          senderId: payload.senderId, plaintext: payload.plaintext, type: payload.type,
          editedAt: payload.editedAt || null, deleted: !!payload.deleted,
          expiresAt: payload.expiresAt || null,
          historyOrder: [record.sortTime, record.id]
        };
      } catch (error) {
        signal?.throwIfAborted();
        assertSession(vault, session);
        // A corrupt record must not hide the rest of the page.
      }
    }
  }));
  assertSession(vault, session);
  signal?.throwIfAborted();
  if (expiredKeys.length) {
    await new Promise((resolve, reject) => {
      const tx = vault.db.transaction(STORE, 'readwrite');
      for (const id of expiredKeys) tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  assertSession(vault, session);
  return messages.filter(Boolean);
}

export async function readMessagePage(vault, groupId, { before = null, limit = 50, signal } = {}) {
  const session = captureSession(vault);
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 50));
  await vault.initDB();
  assertSession(vault, session);
  const prefix = [session.deviceId, String(groupId)];
  const range = IDBKeyRange.bound(prefix, before ? [...prefix, ...before] : [...prefix, []], false, true);
  const records = await new Promise((resolve, reject) => {
    const tx = vault.db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).index('deviceGroupOrder').openCursor(range, 'prev');
    const result = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length === pageSize + 1) return resolve(result);
      result.push(cursor.value);
      if (result.length > pageSize) return resolve(result);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  assertSession(vault, session);
  const page = records.slice(0, pageSize);
  const last = page[page.length - 1];
  return {
    messages: (await decodeRecords(vault, page, session, signal)).reverse(),
    before: last ? [last.sortTime, last.id] : before,
    hasMore: records.length > pageSize
  };
}

export async function findMessageRecord(vault, groupId, messageId) {
  const session = captureSession(vault);
  await vault.initDB();
  assertSession(vault, session);
  const record = await new Promise((resolve, reject) => {
    const tx = vault.db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).index('deviceGroupMessage')
      .openCursor(IDBKeyRange.only([session.deviceId, String(groupId), String(messageId)]), 'prev');
    request.onsuccess = () => resolve(request.result?.value || null);
    request.onerror = () => reject(request.error);
  });
  assertSession(vault, session);
  return record;
}

export async function readMessage(vault, groupId, messageId) {
  const session = captureSession(vault);
  const record = await findMessageRecord(vault, groupId, messageId);
  assertSession(vault, session);
  return record ? (await decodeRecords(vault, [record], session))[0] || null : null;
}
