import { createSignal, For, Show } from 'solid-js';
import { createGroup, searchGroups } from '../../services/api';

export default function CreateGroupForm(props) {
  const [name, setName] = createSignal('');
  const [topicId, setTopicId] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [dupes, setDupes] = createSignal([]);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');
  const [needsVerify, setNeedsVerify] = createSignal(false);

  const checkDupes = async () => {
    const q = name().trim();
    if (q.length < 2) { setDupes([]); return; }
    try { const r = await searchGroups(q, topicId() || null); setDupes(r?.groups || []); }
    catch { setDupes([]); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setNeedsVerify(false);
    if (name().trim().length < 3) { setError('Name must be at least 3 characters.'); return; }
    if (!topicId()) { setError('Please choose a topic.'); return; }
    setSubmitting(true);
    try {
      const r = await createGroup({ name: name().trim(), description: description().trim(), topic_id: Number(topicId()) });
      props.onCreated?.(r.group);
    } catch (err) {
      if (err?.status === 403) setNeedsVerify(true);
      else setError(err?.message || 'Could not create group.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form class="group-create" onSubmit={submit}>
      <Show when={needsVerify()}>
        <div class="group-create-gate">
          Creating a group needs a verified account (phone or payment).{' '}
          <a href="#settings">Verify your account</a> to create one.
        </div>
      </Show>

      <div class="group-create-field">
        <label>Name</label>
        <input class="group-create-input" value={name()} maxlength="80"
          onInput={(e) => setName(e.currentTarget.value)} onBlur={checkDupes} placeholder="e.g. BTC $200k in 2026?" />
        <Show when={dupes().length > 0}>
          <div class="group-create-warn">⚠ Similar group{dupes().length > 1 ? 's' : ''} exist:
            <For each={dupes()}>{(d) => <span> “{d.name}”</span>}</For>. Consider joining instead.
          </div>
        </Show>
      </div>

      <div class="group-create-field">
        <label>Topic</label>
        <select class="group-create-input" value={topicId()} onChange={(e) => setTopicId(e.currentTarget.value)}>
          <option value="">-- choose a topic --</option>
          <For each={props.topics || []}>{(t) => <option value={t.id}>{t.name}</option>}</For>
        </select>
      </div>

      <div class="group-create-field">
        <label>Description</label>
        <textarea class="group-create-input" rows="3" maxlength="500" value={description()}
          onInput={(e) => setDescription(e.currentTarget.value)} placeholder="A sentence or two on the theme." />
      </div>

      <Show when={error()}><p class="error-message">{error()}</p></Show>
      <div class="group-create-actions">
        <button type="submit" class="button primary" disabled={submitting()}>
          {submitting() ? 'Creating…' : 'Create group'}
        </button>
        <span class="group-card-members">You’ll be the owner and first member.</span>
      </div>
    </form>
  );
}
