import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import api from './api';
import { getStoredToken } from './auth';
import { getToken } from './tokenService';

const POLL_MS = 5000;
const pending = (data) => ['pending', 'retrieving', 'reasoning'].includes(data?.status?.processing_status);
const [session, setSession] = createSignal(getStoredToken());
const activeToken = () => getToken() === getStoredToken() ? getToken() : null;
const entries = new Map();
let timer;

// Never reuse metadata across accounts, including a token change in another tab.
const syncSession = () => setSession(getStoredToken());
window.addEventListener('solid-auth-changed', syncSession);
window.addEventListener('storage', syncSession);

const schedule = () => {
  clearTimeout(timer);
  const ready = [...entries.values()].filter((entry) => !entry.busy && entry.token === activeToken());
  const next = Math.min(...ready.map((entry) => entry.due));
  if (Number.isFinite(next)) timer = setTimeout(flush, Math.max(0, next - Date.now()));
};

const invalidate = (entry) => {
  if (!entry) return;
  entry.version += 1;
  entry.failures = 0;
  entry.full = true;
  entry.due = 0;
  schedule();
};

const fetchBatch = async (batch, statusOnly) => {
  const versions = batch.map((entry) => entry.version);
  batch.forEach((entry) => { entry.busy = true; });
  try {
    const response = await api.posts.getMetadata(batch.map((entry) => entry.id), statusOnly);
    const rows = new Map((response.posts || []).map((row) => [String(row.post_id), row]));
    const nextPoll = Date.now() + POLL_MS;
    batch.forEach((entry, index) => {
      if (entries.get(entry.key) !== entry || entry.token !== activeToken()
          || entry.version !== versions[index]) return;
      entry.failures = 0;
      const row = rows.get(String(entry.id));
      if (!row) {
        // Missing and inaccessible posts are indistinguishable; clear old data.
        entry.setData(null);
        entry.full = false;
        entry.due = Infinity;
      } else if (statusOnly && !pending(row)) {
        // Keep existing badges until their replacement arrives, then stop polling.
        entry.full = true;
        entry.due = 0;
      } else {
        entry.setData(statusOnly ? { ...entry.data(), status: row.status } : row);
        entry.full = false;
        entry.due = pending(row) ? nextPoll : Infinity;
      }
    });
  } catch (error) {
    // Permanent client errors cannot improve by polling. Transient failures
    // get three retries (5/10/20 seconds), then wait for an explicit refresh.
    const permanent = error.status >= 400 && error.status < 500
      && ![408, 429].includes(error.status);
    batch.forEach((entry, index) => {
      if (entry.version !== versions[index]) return;
      entry.failures += 1;
      entry.due = permanent || entry.failures > 3
        ? Infinity : Date.now() + POLL_MS * (2 ** (entry.failures - 1));
    });
  } finally {
    batch.forEach((entry) => { entry.busy = false; });
    syncSession();
    schedule();
  }
};

function flush() {
  syncSession();
  const ready = [...entries.values()].filter((entry) =>
    !entry.busy && entry.token === activeToken() && entry.due <= Date.now());
  for (const full of [true, false]) {
    const group = ready.filter((entry) => entry.full === full);
    for (let offset = 0; offset < group.length; offset += 100) {
      void fetchBatch(group.slice(offset, offset + 100), !full);
    }
  }
  schedule();
}

// Subscribers share data only while mounted, keeping long scrolling sessions
// bounded by their rendered posts and cancelling polls when the last one leaves.
export function usePostMetadata(postId, refreshKey = () => 0) {
  const stableId = createMemo(() => Number(postId()));
  const [current, setCurrent] = createSignal(null);
  createEffect(() => {
    const id = stableId();
    session();
    const token = activeToken();
    setCurrent(null);
    if (!token || !Number.isSafeInteger(id) || id <= 0) return;
    const key = `${token}:${id}`;
    let entry = entries.get(key);
    if (!entry) {
      const [data, setData] = createSignal(null);
      entry = { key, id, token, data, setData, refs: 0, version: 0, failures: 0, full: true, due: 0, busy: false };
      entries.set(key, entry);
    }
    entry.refs += 1;
    setCurrent(entry);
    schedule();
    onCleanup(() => {
      entry.refs -= 1;
      if (!entry.refs) entries.delete(key);
      schedule();
    });
  });
  const refresh = () => invalidate(current());
  createEffect(() => {
    refreshKey();
    untrack(refresh);
  });
  return [() => current()?.data() || null, refresh];
}
