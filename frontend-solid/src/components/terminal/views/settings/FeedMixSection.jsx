import { For, Show, createSignal, onMount } from 'solid-js';
import { getFeedWeights, saveFeedWeights } from '../../../../services/api';
import { KEYS, redistribute } from '../../../../lib/feedRanking';

// `LABEL` is not exported from lib/feedRanking — define the display strings locally.
const LABELS = { accuracy: 'ACCURACY', followers: 'FOLLOWERS', likes: 'LIKES', views: 'VIEWS' };
const DEFAULT_WEIGHTS = { accuracy: 25, followers: 25, likes: 25, views: 25 };

export default function FeedMixSection() {
  const [weights, setWeights] = createSignal({ ...DEFAULT_WEIGHTS });
  const [locks, setLocks] = createSignal({});
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(() => {
    getFeedWeights()
      .then((res) => {
        const w = res?.weights;
        if (w && KEYS.every((k) => typeof w[k] === 'number')) setWeights({ ...w });
      })
      .catch(() => { /* keep defaults */ });
  });

  const onSlide = (key, value) => {
    setSaved(false);
    setWeights((w) => redistribute(w, locks(), key, Number(value)));
  };

  const toggleLock = (key) => setLocks((l) => ({ ...l, [key]: !l[key] }));

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await saveFeedWeights(weights());
      setSaved(true);
    } catch (e) {
      setError(e?.message || 'FAILED TO SAVE FEED MIX');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="text-xs">
      <For each={KEYS}>
        {(key) => (
          <div class="flex items-center gap-3 py-1.5">
            <div class="w-24 shrink-0 uppercase text-bb-muted">{LABELS[key]}</div>
            <input
              type="range"
              min="0"
              max="100"
              value={weights()[key]}
              disabled={locks()[key]}
              onInput={(e) => onSlide(key, e.currentTarget.value)}
              class="flex-1 accent-bb-accent disabled:opacity-40"
            />
            <div class="w-10 text-right font-bold text-bb-text">{weights()[key]}</div>
            <button
              type="button"
              onClick={() => toggleLock(key)}
              class={`px-2 py-0.5 border uppercase font-bold ${
                locks()[key] ? 'border-bb-accent text-bb-accent' : 'border-bb-border text-bb-muted hover:text-bb-text'
              }`}
            >
              [LOCK]
            </button>
          </div>
        )}
      </For>
      <div class="flex items-center gap-3 mt-2">
        <button
          type="button"
          data-testid="settings-feedmix-save"
          disabled={saving()}
          onClick={save}
          class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
        >
          {saving() ? '[SAVING...]' : '[SAVE]'}
        </button>
        <Show when={saved()}>
          <span class="text-market-up">SAVED // FEED MIX</span>
        </Show>
        <Show when={error()}>
          <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
        </Show>
      </div>
    </div>
  );
}
