import { createSignal, createEffect, Show, For } from 'solid-js';
import PostItem from '../components/posts/PostItem';
import CreatePostForm from '../components/posts/CreatePostForm';
import { getGroup, joinGroup, leaveGroup, getGroupPosts } from '../services/api';
import { isAuthenticated } from '../services/auth';

export default function GroupPage(props) {
  const slug = () => (typeof props.slug === 'function' ? props.slug() : props.slug);
  const [group, setGroup] = createSignal(null);
  const [tab, setTab] = createSignal('feed');
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [posts, setPosts] = createSignal([]);
  const [feedLoaded, setFeedLoaded] = createSignal(false);
  const loadFeed = async () => {
    const g = group(); if (!g) return;
    try { const r = await getGroupPosts(g.slug, { limit: 30 }); setPosts(r.posts || []); setFeedLoaded(true); }
    catch { setPosts([]); setFeedLoaded(true); }
  };
  createEffect(() => { if (group() && tab() === 'feed' && !feedLoaded()) loadFeed(); });
  const onPosted = (post) => setPosts((cur) => [post, ...cur]);

  createEffect(async () => {
    const s = slug();
    if (!s) return;
    setLoading(true); setError('');
    try { const r = await getGroup(s); setGroup(r.group); }
    catch (e) { setError(e?.status === 404 ? 'Group not found.' : (e?.message || 'Failed to load group.')); setGroup(null); }
    finally { setLoading(false); }
  });

  const toggle = async () => {
    const g = group();
    if (!g || !isAuthenticated() || busy()) return;
    setBusy(true);
    try {
      const res = g.is_member ? await leaveGroup(g.id) : await joinGroup(g.id);
      setGroup({ ...g, is_member: res.is_member, member_count: res.member_count });
    } catch { /* leave unchanged */ } finally { setBusy(false); }
  };

  return (
    <section class="group-page">
      <a class="group-back" href="#groups">‹ Groups</a>
      <Show when={loading()}><p>Loading…</p></Show>
      <Show when={error()}><p class="error-message">{error()}</p></Show>
      <Show when={group()}>
        <div class="group-detail-card">
          <div class="group-detail-head">
            <div class="group-detail-titlerow">
              <h1 class="group-detail-name">{group().name}</h1>
              <span class="group-chip">{group().topic_name}</span>
            </div>
            <Show when={group().description}><p class="group-detail-desc">{group().description}</p></Show>
            <div class="group-detail-actions">
              <span class="group-card-members">{group().member_count} member{group().member_count === 1 ? '' : 's'}</span>
              <Show when={isAuthenticated()}>
                <button type="button" class={`group-join ${group().is_member ? 'joined' : ''}`} onClick={toggle} disabled={busy()}>
                  {group().is_member ? 'Joined ✓' : 'Join'}
                </button>
              </Show>
            </div>
          </div>
          <div class="group-tabs">
            <button type="button" class={`group-tab ${tab() === 'feed' ? 'on' : ''}`} onClick={() => setTab('feed')}>Feed</button>
            <button type="button" class="group-tab disabled" disabled>Chat <span class="group-tab-soon">soon</span></button>
            <button type="button" class="group-tab disabled" disabled>Markets <span class="group-tab-soon">later</span></button>
          </div>
          <div class="group-tab-body" classList={{ 'group-feed-body': tab() === 'feed' }}>
            <Show when={tab() === 'feed'} fallback={<p class="groups-empty">Coming soon.</p>}>
              <Show when={group().is_member} fallback={<p class="groups-empty">Join this group to post.</p>}>
                <CreatePostForm groupId={group().id} onCreated={onPosted} />
              </Show>
              <Show when={feedLoaded() && posts().length === 0}>
                <p class="groups-empty">No posts yet — be the first to post in this group.</p>
              </Show>
              <div class="posts-list">
                <For each={posts()}>{(p) => <PostItem post={p} onPostUpdate={() => {}} onPostDelete={() => setPosts((c) => c.filter((x) => x.id !== p.id))} />}</For>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </section>
  );
}
