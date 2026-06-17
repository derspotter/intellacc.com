import { createSignal, createEffect, For, Show } from 'solid-js';
import api, { listGroups } from '../services/api';
import { isAuthenticated } from '../services/auth';
import GroupCard from '../components/groups/GroupCard';
import CreateGroupForm from '../components/groups/CreateGroupForm';

export default function GroupsPage() {
  const [topics, setTopics] = createSignal([]);
  const [activeTopic, setActiveTopic] = createSignal(null);
  const [sort, setSort] = createSignal('members');
  const [groups, setGroups] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [showCreate, setShowCreate] = createSignal(false);

  api.topics.list().then((r) => setTopics(r?.topics || [])).catch(() => {});

  const load = async () => {
    setLoading(true); setError('');
    try {
      const r = await listGroups({ topic: activeTopic(), sort: sort() });
      setGroups(r?.groups || []);
    } catch (e) { setError(e?.message || 'Failed to load groups.'); }
    finally { setLoading(false); }
  };

  createEffect(() => { activeTopic(); sort(); load(); });

  const onCreated = (group) => { setShowCreate(false); window.location.hash = `#group/${group.slug}`; };

  return (
    <section class="groups-page">
      <div class="groups-header">
        <h1>Groups</h1>
        <Show when={isAuthenticated()}>
          <button type="button" class="button primary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate() ? 'Close' : '+ New group'}
          </button>
        </Show>
      </div>

      <Show when={showCreate()}>
        <CreateGroupForm topics={topics()} onCreated={onCreated} />
      </Show>

      <div class="groups-controls">
        <div class="groups-tabs">
          <button type="button" class={`groups-tab ${activeTopic() === null ? 'on' : ''}`} onClick={() => setActiveTopic(null)}>All</button>
          <For each={topics()}>
            {(t) => (
              <button type="button" class={`groups-tab ${activeTopic() === t.id ? 'on' : ''}`} onClick={() => setActiveTopic(t.id)}>{t.name}</button>
            )}
          </For>
        </div>
        <select class="groups-sort" value={sort()} onChange={(e) => setSort(e.currentTarget.value)}>
          <option value="members">Most members</option>
          <option value="recent">Most recent</option>
        </select>
      </div>

      <Show when={error()}><p class="error-message">{error()}</p></Show>
      <Show when={loading()}><p>Loading groups…</p></Show>
      <Show when={!loading() && groups().length === 0}>
        <p class="groups-empty">No groups here yet — start one.</p>
      </Show>
      <div class="groups-list">
        <For each={groups()}>{(g) => <GroupCard group={g} />}</For>
      </div>
    </section>
  );
}
