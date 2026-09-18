// One view's decrypted window. No plaintext survives selection changes, locking
// or disposal. Relay processing stays in coreCryptoClient, in its original order.
export function createMessageHistory(vault, { onChange, onError = () => {}, pageSize = 50 }) {
  let groupId = '';
  let generation = 0;
  let rows = new Map();
  let before = null;
  let hasMore = false;
  let loading = false;
  let initialized = false;
  let error = '';
  let disposed = false;
  let queue = Promise.resolve();
  let expiryTimer;
  let abortController = new AbortController();

  const current = (token) => !disposed && token === generation;
  const ordered = () => [...rows.values()].sort((a, b) =>
    a.historyOrder[0] - b.historyOrder[0] || a.historyOrder[1] - b.historyOrder[1]);

  const publish = (reset = false) => {
    clearTimeout(expiryTimer);
    const now = Date.now();
    let nextExpiry = Infinity;
    for (const [id, row] of rows) {
      if (!row.expiresAt) continue;
      if (Number(row.expiresAt) <= now) rows.delete(id);
      else nextExpiry = Math.min(nextExpiry, Number(row.expiresAt));
    }
    onChange({ groupId, messages: ordered(), hasMore, loading, reset, error });
    if (Number.isFinite(nextExpiry)) {
      const token = generation;
      expiryTimer = setTimeout(() => {
        if (current(token)) publish();
      }, Math.min(2147483647, Math.max(1, nextExpiry - Date.now())));
    }
  };

  const enqueue = (work) => {
    const token = generation;
    const result = queue.then(async () => {
      if (current(token)) await work(token);
    });
    queue = result.catch((failure) => {
      if (current(token)) {
        error = failure?.message || 'Failed to load message history.';
        onError(failure);
        publish();
      }
    });
    return queue;
  };

  const clear = () => {
    abortController.abort();
    abortController = new AbortController();
    generation++;
    groupId = '';
    rows.clear();
    before = null;
    hasMore = false;
    initialized = false;
    error = '';
    loading = false;
    queue = Promise.resolve();
    publish(true);
  };

  const loadPage = () => {
    if (disposed || !groupId || loading) return queue;
    loading = true;
    error = '';
    publish();
    return enqueue(async (token) => {
      try {
        const page = await vault.getMessagePage(groupId, { before, limit: pageSize, signal: abortController.signal });
        if (!current(token)) return;
        const loaded = new Set(rows.keys());
        for (const row of page.messages) {
          // Legacy duplicate relay IDs on older pages must not replace the
          // newer copy already loaded or received through a commit event.
          if (!loaded.has(String(row.id))) rows.set(String(row.id), row);
        }
        before = page.before;
        hasMore = page.hasMore;
        initialized = true;
      } finally {
        if (current(token)) {
          loading = false;
          publish();
        }
      }
    });
  };

  const unsubscribe = vault.subscribeMessageChanges((change) => {
    if (change.kind === 'reset') return clear();
    if (!groupId || String(change.groupId) !== groupId || change.deviceId !== vault.deviceId) return;
    if (!initialized && !loading) void loadPage();
    void enqueue(async (token) => {
      // Edits outside the loaded window are picked up when that page is opened.
      if (change.kind === 'update' && !rows.has(String(change.messageId))) return;
      const row = await vault.getMessage(groupId, change.messageId);
      if (!current(token)) return;
      if (row) rows.set(String(row.id), row);
      else rows.delete(String(change.messageId));
      publish();
    });
  });

  return {
    select(nextGroupId) {
      if (disposed) return Promise.resolve();
      const next = String(nextGroupId || '');
      if (next !== groupId) {
        clear();
        groupId = next;
      }
      if (!groupId || !vault.isUnlocked()) return Promise.resolve();
      return initialized ? queue : loadPage();
    },
    loadOlder() { return hasMore ? loadPage() : queue; },
    idle() { return queue; },
    clear,
    dispose() {
      clear();
      disposed = true;
      unsubscribe();
    }
  };
}

// Keep unsent rows while committed rows arrive, but never duplicate a confirmed
// relay ID. The send handler replaces its optimistic ID when persistence ends.
export function mergeOptimisticMessages(messages, previous) {
  const ids = new Set(messages.map((row) => String(row.id)));
  return [...messages, ...previous.filter((row) => row.optimistic && !ids.has(String(row.id)))];
}
