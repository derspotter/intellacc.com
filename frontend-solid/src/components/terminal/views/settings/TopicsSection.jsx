import { For, Show, createSignal, onMount } from 'solid-js';
import { api } from '../../../../services/api';

export default function TopicsSection() {
  const [topics, setTopics] = createSignal([]);
  const [selected, setSelected] = createSignal(new Set());
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(async () => {
    try {
      const [listRes, mineRes] = await Promise.all([
        api.topics.list(),
        api.topics.getMine()
      ]);
      setTopics(listRes?.topics || []);
      setSelected(new Set(mineRes?.topicIds || []));
    } catch (e) {
      setError(e?.message || 'FAILED TO LOAD TOPICS');
    } finally {
      setLoading(false);
    }
  });

  const toggle = (id) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await api.topics.setMine([...selected()]);
      setSaved(true);
    } catch (e) {
      setError(e?.message || 'FAILED TO SAVE TOPICS');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="text-xs">
      <Show when={loading()}>
        <div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>
      </Show>
      <Show when={!loading()}>
        <Show when={topics().length > 0} fallback={<div class="text-bb-muted">NO TOPICS AVAILABLE</div>}>
          <div class="flex flex-wrap gap-2 mb-3">
            <For each={topics()}>
              {(topic) => (
                <button
                  type="button"
                  data-testid="topic-chip"
                  onClick={() => toggle(topic.id)}
                  class={`px-2 py-1 border uppercase font-bold ${
                    selected().has(topic.id)
                      ? 'bg-bb-accent/15 text-bb-accent border-bb-accent'
                      : 'border-bb-border text-bb-muted hover:text-bb-text hover:border-bb-text'
                  }`}
                >
                  [{topic.name}]
                </button>
              )}
            </For>
          </div>
          <div class="flex items-center gap-3">
            <button
              type="button"
              data-testid="topics-save"
              disabled={saving()}
              onClick={save}
              class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
            >
              {saving() ? '[SAVING...]' : '[SAVE TOPICS]'}
            </button>
            <Show when={saved()}>
              <span class="text-market-up">SAVED // TOPICS</span>
            </Show>
            <Show when={error()}>
              <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}
