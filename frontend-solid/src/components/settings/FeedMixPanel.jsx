import { createSignal, onMount, onCleanup, For, Show } from 'solid-js';
import Card from '../common/Card';
import { redistribute, normalizeWeights, KEYS } from '../../lib/feedRanking';
import { getFeedWeights, saveFeedWeights } from '../../services/api';

const LABEL = { accuracy: 'Accuracy', followers: 'Followers', likes: 'Likes', views: 'Views' };
const DEFAULT = { accuracy: 25, followers: 25, likes: 25, views: 25 };

export default function FeedMixPanel() {
  const [weights, setWeights] = createSignal({ ...DEFAULT });
  const [locks, setLocks] = createSignal({ accuracy: false, followers: false, likes: false, views: false });
  const [saving, setSaving] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');

  onMount(async () => {
    try {
      const res = await getFeedWeights();
      // Normalize to a 100-sum for display; falls back to DEFAULT when the
      // server has nothing usable ({ weights: null } for a fresh user).
      const norm = normalizeWeights(res?.weights);
      if (norm) setWeights(norm);
    } catch (err) {
      setError(err?.message || 'Failed to load your feed mix.');
    }
  });

  const valueFromPointer = (trackEl, clientY) => {
    const rect = trackEl.getBoundingClientRect();
    const pct = 1 - (clientY - rect.top) / rect.height;
    return Math.max(0, Math.min(100, Math.round(pct * 100)));
  };

  const applyDrag = (key, value) => {
    if (locks()[key]) return;
    setWeights((w) => redistribute(w, locks(), key, value));
    setMessage('');
  };

  let teardownDrag = null;
  const startDrag = (key, trackEl) => (e) => {
    if (locks()[key]) return;
    e.preventDefault();
    applyDrag(key, valueFromPointer(trackEl, e.clientY));
    const move = (ev) => applyDrag(key, valueFromPointer(trackEl, ev.clientY));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      teardownDrag = null;
    };
    teardownDrag = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Remove any in-flight drag listeners if the panel unmounts mid-drag.
  onCleanup(() => { if (teardownDrag) teardownDrag(); });

  const onKey = (key) => (e) => {
    if (locks()[key]) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp') { e.preventDefault(); applyDrag(key, weights()[key] + step); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); applyDrag(key, weights()[key] - step); }
  };

  const toggleLock = (key) => setLocks((l) => ({ ...l, [key]: !l[key] }));

  const save = async () => {
    setSaving(true); setError(''); setMessage('');
    try {
      await saveFeedWeights(weights());
      setMessage('Feed mix saved.');
    } catch (err) {
      setError(err?.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Feed Mix" className="feed-mix">
      <p class="feed-mix-help">Weight your home feed. The four always add up to 100% — drag one and the
        unlocked others rebalance; lock one to pin it.</p>
      <div class="feed-mix-channels">
        <For each={KEYS}>
          {(key) => {
            let trackRef;
            return (
              <div class="feed-mix-ch">
                <div class="feed-mix-pct">{weights()[key]}%</div>
                <div
                  class="feed-mix-track"
                  ref={(el) => (trackRef = el)}
                  role="slider"
                  tabindex="0"
                  aria-label={LABEL[key]}
                  aria-valuenow={weights()[key]}
                  aria-valuemin="0"
                  aria-valuemax="100"
                  onPointerDown={(e) => startDrag(key, trackRef)(e)}
                  onKeyDown={onKey(key)}
                >
                  <div class="feed-mix-fill" style={{ height: `${weights()[key]}%` }} />
                  <div class="feed-mix-thumb" style={{ bottom: `${weights()[key]}%` }} />
                </div>
                <div class="feed-mix-name">{LABEL[key]}</div>
                <button
                  type="button"
                  class="feed-mix-lock"
                  aria-pressed={locks()[key]}
                  onClick={() => toggleLock(key)}
                >
                  <span class={`feed-mix-box ${locks()[key] ? 'on' : ''}`}>
                    <Show when={locks()[key]}>
                      <svg width="10" height="10" viewBox="0 0 16 16"><path d="M2.5 8.5 L6.5 12.5 L13.5 4" fill="none" stroke="#0000ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </Show>
                  </span>
                  Lock
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <div class="feed-mix-actions">
        <button type="button" class="button primary" onClick={save} disabled={saving()}>
          {saving() ? 'Saving…' : 'Save'}
        </button>
        <Show when={message()}><span class="feed-mix-msg success">{message()}</span></Show>
        <Show when={error()}><span class="feed-mix-msg error-message">{error()}</span></Show>
      </div>
    </Card>
  );
}
