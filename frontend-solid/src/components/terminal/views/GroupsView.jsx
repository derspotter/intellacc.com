import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { api, createGroup, joinGroup, leaveGroup, listGroups, searchGroups } from '../../../services/api';
import { createEpochGuard } from '../../../lib/requestEpoch';

export default function GroupsView() {
  const [topics, setTopics] = createSignal([]);
  const [topicFilter, setTopicFilter] = createSignal(null); // null = ALL
  const [sort, setSort] = createSignal('members'); // 'members' | 'recent'
  const [query, setQuery] = createSignal('');
  const [groups, setGroups] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  const [showCreate, setShowCreate] = createSignal(false);
  const [createName, setCreateName] = createSignal('');
  const [createDescription, setCreateDescription] = createSignal('');
  const [createTopicId, setCreateTopicId] = createSignal('');
  const [createSubmitting, setCreateSubmitting] = createSignal(false);
  const [createError, setCreateError] = createSignal('');
  const [needsVerify, setNeedsVerify] = createSignal(false);

  let debounceTimer;
  const guard = createEpochGuard();
  onCleanup(() => clearTimeout(debounceTimer));

  const load = async () => {
    const q = query().trim();
    const token = guard.begin();
    setLoading(true);
    setError('');
    try {
      const res = q
        ? await searchGroups(q, topicFilter())
        : await listGroups({ topic: topicFilter(), sort: sort() });
      if (!guard.isCurrent(token)) return;
      setGroups(Array.isArray(res?.groups) ? res.groups : []);
    } catch (e) {
      if (!guard.isCurrent(token)) return;
      setError(e?.message || 'FAILED TO LOAD GROUPS');
      setGroups([]);
    } finally {
      if (guard.isCurrent(token)) setLoading(false);
    }
  };

  onMount(() => {
    api.topics.list()
      .then((r) => {
        const list = Array.isArray(r?.topics) ? r.topics : [];
        setTopics(list);
        if (list.length && !createTopicId()) setCreateTopicId(String(list[0].id));
      })
      .catch(() => setTopics([]));
    load();
  });

  const onSearchInput = (e) => {
    setQuery(e.currentTarget.value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, 300);
  };

  const selectTopic = (id) => { setTopicFilter(id); load(); };
  const toggleSort = () => { setSort((s) => (s === 'members' ? 'recent' : 'members')); load(); };

  const openGroup = (g) => { window.location.hash = `#group/${g.slug}`; };

  const toggleMembership = async (g, ev) => {
    ev.stopPropagation();
    try {
      const res = g.is_member ? await leaveGroup(g.id) : await joinGroup(g.id);
      setGroups((prev) => prev.map((x) => (
        x.id === g.id ? { ...x, is_member: res.is_member, member_count: res.member_count } : x
      )));
    } catch (e) {
      setError(e?.message || 'ACTION FAILED');
    }
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    setCreateError('');
    setNeedsVerify(false);
    const nm = createName().trim();
    if (nm.length < 3) { setCreateError('NAME MUST BE AT LEAST 3 CHARACTERS'); return; }
    if (!createTopicId()) { setCreateError('A TOPIC IS REQUIRED'); return; }
    setCreateSubmitting(true);
    try {
      const res = await createGroup({
        name: nm,
        description: createDescription().trim(),
        topic_id: Number(createTopicId())
      });
      window.location.hash = `#group/${res.group.slug}`;
    } catch (err) {
      if (err?.status === 403) setNeedsVerify(true);
      else setCreateError(err?.message || 'COULD NOT CREATE GROUP');
    } finally {
      setCreateSubmitting(false);
    }
  };

  return (
    <div class="h-full flex flex-col font-mono text-sm">
      <div class="shrink-0 border-b border-bb-border bg-bb-panel px-3 py-2 flex items-center gap-2">
        <span class="text-bb-accent font-bold">/</span>
        <input
          type="text"
          data-testid="groups-search"
          class="flex-1 bg-transparent border-none outline-none text-bb-text placeholder-bb-muted"
          placeholder="SEARCH GROUPS..."
          value={query()}
          onInput={onSearchInput}
        />
        <button
          type="button"
          onClick={toggleSort}
          class="shrink-0 px-2 py-0.5 border border-bb-border text-bb-muted hover:text-bb-text uppercase text-xxs font-bold"
        >
          {sort() === 'members' ? '[MEMBERS]' : '[RECENT]'}
        </button>
        <button
          type="button"
          data-testid="groups-new"
          onClick={() => setShowCreate((v) => !v)}
          class="shrink-0 px-2 py-0.5 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase text-xxs font-bold"
        >
          [+ NEW GROUP]
        </button>
      </div>

      <div class="shrink-0 flex flex-wrap gap-1 border-b border-bb-border bg-bb-panel px-3 py-1.5 text-xxs select-none">
        <button
          type="button"
          onClick={() => selectTopic(null)}
          class={`px-2 py-0.5 uppercase font-bold ${topicFilter() == null ? 'bg-bb-accent/15 text-bb-accent' : 'text-bb-muted hover:text-bb-text'}`}
        >
          [ALL]
        </button>
        <For each={topics()}>
          {(t) => (
            <button
              type="button"
              onClick={() => selectTopic(t.id)}
              class={`px-2 py-0.5 uppercase font-bold ${topicFilter() === t.id ? 'bg-bb-accent/15 text-bb-accent' : 'text-bb-muted hover:text-bb-text'}`}
            >
              [{t.name}]
            </button>
          )}
        </For>
      </div>

      <Show when={showCreate()}>
        <form onSubmit={submitCreate} class="shrink-0 border-b border-bb-border bg-bb-panel px-3 py-3 flex flex-col gap-2 text-xs">
          <Show when={needsVerify()}>
            <div data-testid="group-create-gate" class="p-2 border border-market-down text-market-down text-xxs uppercase font-bold">
              NEEDS VERIFIED ACCOUNT // SEE SETTINGS
            </div>
          </Show>
          <div class="flex items-center gap-2">
            <label class="text-bb-muted w-24 shrink-0 uppercase">Name</label>
            <input
              type="text"
              data-testid="group-create-name"
              class="flex-1 bg-bb-bg border border-bb-border px-2 py-1 text-bb-text outline-none"
              maxlength="80"
              value={createName()}
              onInput={(e) => setCreateName(e.currentTarget.value)}
            />
          </div>
          <div class="flex items-center gap-2">
            <label class="text-bb-muted w-24 shrink-0 uppercase">Topic</label>
            <select
              data-testid="group-create-topic"
              class="flex-1 bg-bb-bg border border-bb-border px-2 py-1 text-bb-text outline-none"
              value={createTopicId()}
              onChange={(e) => setCreateTopicId(e.currentTarget.value)}
            >
              <For each={topics()}>{(t) => <option value={t.id}>{t.name}</option>}</For>
            </select>
          </div>
          <div class="flex items-start gap-2">
            <label class="text-bb-muted w-24 shrink-0 uppercase pt-1">Description</label>
            <textarea
              data-testid="group-create-description"
              class="flex-1 bg-bb-bg border border-bb-border px-2 py-1 text-bb-text outline-none"
              rows="2"
              maxlength="500"
              value={createDescription()}
              onInput={(e) => setCreateDescription(e.currentTarget.value)}
            />
          </div>
          <Show when={createError()}>
            <div class="text-market-down text-xxs uppercase">{createError()}</div>
          </Show>
          <div>
            <button
              type="submit"
              data-testid="group-create-submit"
              disabled={createSubmitting()}
              class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase font-bold disabled:opacity-50"
            >
              {createSubmitting() ? '[CREATING...]' : '[CREATE]'}
            </button>
          </div>
        </form>
      </Show>

      <div class="grid grid-cols-[minmax(0,1fr)_max-content_max-content_max-content] px-3 py-1 border-b border-bb-border text-bb-muted bg-bb-panel text-xs">
        <div>NAME</div>
        <div class="px-3">TOPIC</div>
        <div class="px-3 text-right">MEMBERS</div>
        <div class="text-right">ACTION</div>
      </div>

      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <Show when={error()}>
          <div class="p-3 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>
        </Show>
        <Show when={loading()}>
          <div class="p-3 text-bb-muted animate-pulse text-xs">RUNNING QUERY...</div>
        </Show>
        <Show when={!loading()}>
          <Show when={groups().length > 0} fallback={<div class="p-4 text-bb-muted" data-testid="groups-empty">NO GROUPS FOUND</div>}>
            <For each={groups()}>
              {(g, index) => (
                <div
                  data-testid="groups-row"
                  onClick={() => openGroup(g)}
                  class={`grid grid-cols-[minmax(0,1fr)_max-content_max-content_max-content] px-3 py-1.5 border-b border-bb-border/20 text-xs cursor-pointer hover:bg-white/5 ${index() % 2 === 0 ? 'bg-bb-bg' : 'bg-[#0a0a0a]'}`}
                >
                  <div class="truncate font-bold">{g.name}</div>
                  <div class="px-3 text-bb-muted truncate">{g.topic_name || '—'}</div>
                  <div class="px-3 text-right text-bb-muted">{g.member_count ?? 0}</div>
                  <div class="text-right">
                    <button
                      type="button"
                      data-testid="groups-join"
                      onClick={(ev) => toggleMembership(g, ev)}
                      class={`px-2 py-0.5 border uppercase text-xxs font-bold ${g.is_member ? 'border-bb-border text-bb-muted hover:text-bb-text' : 'border-bb-accent text-bb-accent hover:bg-bb-accent/20'}`}
                    >
                      {g.is_member ? '[LEAVE]' : '[JOIN]'}
                    </button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
