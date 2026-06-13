import { createSignal, createResource, Show, For } from 'solid-js';
import api from '../../services/api';

const fetchTopics = async () => {
  const res = await api.topics.list();
  return res?.topics || [];
};

// First sentence of a topic description, for a compact one-line blurb.
const firstSentence = (text) => {
  if (!text) return '';
  const match = String(text).match(/^[^.!?]*[.!?]?/);
  return (match ? match[0] : String(text)).trim();
};

export default function TopicPicker(props) {
  const [topics] = createResource(fetchTopics);
  const [selected, setSelected] = createSignal(new Set());
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal(null);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const count = () => selected().size;
  const canContinue = () => count() >= 3 && !saving();

  const handleContinue = async () => {
    if (!canContinue()) return;
    setSaving(true);
    setError(null);
    try {
      await api.topics.setMine([...selected()]);
      props.onDone?.();
    } catch (err) {
      setError(err?.message || 'Could not save your topics. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="topic-picker">
      <h1>Pick your topics</h1>
      <p>
        You'll get a weekly question from these, and your feed starts with the
        best predictors in them. Pick at least three. You can change these any
        time in Settings.
      </p>

      <Show when={!topics.loading} fallback={<p>Loading topics…</p>}>
        <Show
          when={topics()?.length}
          fallback={<p class="error">No topics available right now.</p>}
        >
          <div class="topic-grid">
            <For each={topics()}>
              {(topic) => (
                <button
                  type="button"
                  class={`topic-option${selected().has(topic.id) ? ' selected' : ''}`}
                  aria-pressed={selected().has(topic.id)}
                  onClick={() => toggle(topic.id)}
                >
                  <strong>{topic.name}</strong>
                  <Show when={topic.description}>
                    <span>{firstSentence(topic.description)}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>

      <div class="topic-picker-actions">
        <span>{count()} selected (3 minimum)</span>
        <button
          type="button"
          class="button primary"
          disabled={!canContinue()}
          onClick={handleContinue}
        >
          {saving() ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
