import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import {
  getGroup,
  joinGroup,
  leaveGroup,
  getGroupPosts,
  postToGroup,
  removeGroupPost,
  getGroupMessages,
  sendGroupMessage,
  getGroupMarkets,
  pinGroupMarket,
  unpinGroupMarket,
  getEvents,
  getGroupMembers,
  removeGroupMember,
  reportGroup
} from '../../../services/api';
import { joinGroupChat, leaveGroupChat } from '../../../services/socket';
import { isLoggedIn } from '../../../services/tokenService';
import PostItem from '../PostItem';

const TABS = [
  { key: 'feed', label: 'FEED' },
  { key: 'chat', label: 'CHAT' },
  { key: 'markets', label: 'MARKETS' },
  { key: 'members', label: 'MEMBERS' }
];

const pct = (p) => (p == null ? '—' : `${Math.round(Number(p) * 100)}%`);
const day = (d) => (d ? new Date(d).toLocaleDateString() : '');

export default function GroupView(props) {
  const slug = () => (props.param ? String(props.param) : null);

  const [group, setGroup] = createSignal(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [notFound, setNotFound] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [tab, setTab] = createSignal('feed');

  const [reportOpen, setReportOpen] = createSignal(false);
  const [reportReason, setReportReason] = createSignal('');
  const [reportMsg, setReportMsg] = createSignal('');
  const [reportBusy, setReportBusy] = createSignal(false);

  // Feed tab
  const [posts, setPosts] = createSignal([]);
  const [feedLoaded, setFeedLoaded] = createSignal(false);
  const [postText, setPostText] = createSignal('');
  const [postBusy, setPostBusy] = createSignal(false);
  const [postError, setPostError] = createSignal('');

  // Chat tab
  const [messages, setMessages] = createSignal([]);
  const [chatLoaded, setChatLoaded] = createSignal(false);
  const [chatText, setChatText] = createSignal('');
  const [chatBusy, setChatBusy] = createSignal(false);
  const [chatError, setChatError] = createSignal('');

  // Markets tab
  const [markets, setMarkets] = createSignal([]);
  const [marketsLoaded, setMarketsLoaded] = createSignal(false);
  const [pinQuery, setPinQuery] = createSignal('');
  const [pinResults, setPinResults] = createSignal([]);
  const [marketBusy, setMarketBusy] = createSignal(false);
  let pinDebounce;
  onCleanup(() => clearTimeout(pinDebounce));

  // Members tab
  const [members, setMembers] = createSignal([]);
  const [membersLoaded, setMembersLoaded] = createSignal(false);
  const [memberBusy, setMemberBusy] = createSignal(false);

  let loadEpoch = 0;

  // Reload everything whenever the slug changes (epoch-guarded, same pattern
  // as ProfileView so a stale in-flight response can never clobber a newer
  // one when the user navigates group -> group).
  createEffect(() => {
    const s = slug();
    setGroup(null);
    setError('');
    setNotFound(false);
    setTab('feed');
    setPosts([]); setFeedLoaded(false); setPostText(''); setPostError('');
    setMessages([]); setChatLoaded(false); setChatText(''); setChatError('');
    setMarkets([]); setMarketsLoaded(false); setPinQuery(''); setPinResults([]);
    setMembers([]); setMembersLoaded(false);
    setReportOpen(false); setReportReason(''); setReportMsg('');
    if (!s) { setLoading(false); return; }
    const epoch = ++loadEpoch;
    setLoading(true);
    getGroup(s)
      .then((r) => {
        if (epoch !== loadEpoch) return;
        setGroup(r?.group || null);
      })
      .catch((e) => {
        if (epoch !== loadEpoch) return;
        if (e?.status === 404) setNotFound(true);
        else setError(e?.message || 'FAILED TO LOAD GROUP');
      })
      .finally(() => {
        if (epoch === loadEpoch) setLoading(false);
      });
  });

  const toggleMembership = async () => {
    const g = group();
    if (!g || busy()) return;
    setBusy(true);
    try {
      const res = g.is_member ? await leaveGroup(g.id) : await joinGroup(g.id);
      setGroup({ ...g, is_member: res.is_member, member_count: res.member_count });
    } catch (e) {
      setError(e?.message || 'ACTION FAILED');
    } finally {
      setBusy(false);
    }
  };

  const submitReport = async (e) => {
    e.preventDefault();
    const reason = reportReason().trim();
    if (!reason || reportBusy()) return;
    setReportBusy(true);
    try {
      await reportGroup(group().id, reason);
      setReportMsg('REPORTED // THANKS');
      setReportOpen(false);
    } catch (err) {
      setReportMsg(err?.message || 'COULD NOT REPORT');
    } finally {
      setReportBusy(false);
    }
  };

  // --- Feed ---
  const loadFeed = async () => {
    const g = group();
    if (!g) return;
    const epoch = loadEpoch;
    try {
      const r = await getGroupPosts(g.slug, { limit: 30 });
      if (epoch !== loadEpoch) return;
      setPosts(Array.isArray(r?.posts) ? r.posts : []);
    } catch {
      if (epoch !== loadEpoch) return;
      setPosts([]);
    } finally {
      if (epoch === loadEpoch) setFeedLoaded(true);
    }
  };
  createEffect(() => {
    if (group() && tab() === 'feed' && !feedLoaded()) loadFeed();
  });

  const submitPost = async () => {
    const g = group();
    const text = postText().trim();
    if (!g || !text || postBusy()) return;
    const epoch = loadEpoch;
    setPostBusy(true);
    setPostError('');
    try {
      const created = await postToGroup(g.id, text);
      if (epoch !== loadEpoch) return;
      setPosts((cur) => [created, ...cur]);
      setPostText('');
    } catch (e) {
      if (epoch !== loadEpoch) return;
      setPostError(e?.message || 'FAILED TO POST');
    } finally {
      if (epoch === loadEpoch) setPostBusy(false);
    }
  };

  const removePost = async (postId) => {
    const g = group();
    if (!g) return;
    const epoch = loadEpoch;
    try {
      await removeGroupPost(g.id, postId);
      if (epoch !== loadEpoch) return;
      setPosts((cur) => cur.filter((p) => p.id !== postId));
    } catch (e) {
      if (epoch !== loadEpoch) return;
      setError(e?.message || 'FAILED TO REMOVE POST');
    }
  };

  // --- Chat ---
  const loadChat = async () => {
    const g = group();
    if (!g) return;
    const epoch = loadEpoch;
    try {
      const r = await getGroupMessages(g.slug, { limit: 50 });
      if (epoch !== loadEpoch) return;
      setMessages(Array.isArray(r?.messages) ? r.messages : []);
    } catch {
      if (epoch !== loadEpoch) return;
      setMessages([]);
    } finally {
      if (epoch === loadEpoch) setChatLoaded(true);
    }
  };
  createEffect(() => {
    if (group() && tab() === 'chat' && !chatLoaded()) loadChat();
  });

  // Join the socket room whenever the chat tab is active for the current
  // group; the returned onCleanup runs both when leaving the tab (effect
  // re-runs) and when the view unmounts entirely (owner disposal) — a single
  // mechanism covers both exit paths the brief calls out.
  createEffect(() => {
    const g = group();
    if (!g || tab() !== 'chat') return;
    const handler = (m) => {
      if (!m || m.id == null) return;
      setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
    };
    joinGroupChat(g.id, handler);
    onCleanup(() => leaveGroupChat(g.id, handler));
  });

  const submitChat = async () => {
    const g = group();
    const text = chatText().trim();
    if (!g || !text || chatBusy()) return;
    setChatBusy(true);
    try {
      // The sender's own message arrives back through the socket room echo
      // (joinGroupChat put us in it) — no local append here.
      await sendGroupMessage(g.id, text);
      setChatText('');
      setChatError('');
    } catch {
      /* keep text so the user can retry */
      setChatError('SEND FAILED // RETRY');
    } finally {
      setChatBusy(false);
    }
  };

  // --- Markets ---
  const loadMarkets = async () => {
    const g = group();
    if (!g) return;
    const epoch = loadEpoch;
    try {
      const r = await getGroupMarkets(g.slug);
      if (epoch !== loadEpoch) return;
      setMarkets(Array.isArray(r?.markets) ? r.markets : []);
    } catch {
      if (epoch !== loadEpoch) return;
      setMarkets([]);
    } finally {
      if (epoch === loadEpoch) setMarketsLoaded(true);
    }
  };
  createEffect(() => {
    if (group() && tab() === 'markets' && !marketsLoaded()) loadMarkets();
  });

  const onPinInput = (e) => {
    const value = e.currentTarget.value;
    setPinQuery(value);
    clearTimeout(pinDebounce);
    const text = value.trim();
    if (text.length < 2) { setPinResults([]); return; }
    pinDebounce = setTimeout(async () => {
      try {
        const evs = await getEvents(text);
        setPinResults((Array.isArray(evs) ? evs : []).slice(0, 10));
      } catch {
        setPinResults([]);
      }
    }, 300);
  };

  const pinMarket = async (eventId) => {
    const g = group();
    if (!g || marketBusy()) return;
    const epoch = loadEpoch;
    setMarketBusy(true);
    try {
      await pinGroupMarket(g.id, eventId);
      if (epoch !== loadEpoch) return;
      setPinQuery(''); setPinResults([]);
      await loadMarkets();
    } catch (e) {
      if (epoch !== loadEpoch) return;
      setError(e?.message || 'FAILED TO PIN MARKET');
    } finally {
      if (epoch === loadEpoch) setMarketBusy(false);
    }
  };

  const unpinMarket = async (eventId) => {
    const g = group();
    if (!g || marketBusy()) return;
    const epoch = loadEpoch;
    setMarketBusy(true);
    try {
      await unpinGroupMarket(g.id, eventId);
      if (epoch !== loadEpoch) return;
      await loadMarkets();
    } catch (e) {
      if (epoch !== loadEpoch) return;
      setError(e?.message || 'FAILED TO UNPIN MARKET');
    } finally {
      if (epoch === loadEpoch) setMarketBusy(false);
    }
  };

  // --- Members ---
  const loadMembers = async () => {
    const g = group();
    if (!g) return;
    const epoch = loadEpoch;
    try {
      const r = await getGroupMembers(g.slug);
      if (epoch !== loadEpoch) return;
      setMembers(Array.isArray(r?.members) ? r.members : []);
    } catch {
      if (epoch !== loadEpoch) return;
      setMembers([]);
    } finally {
      if (epoch === loadEpoch) setMembersLoaded(true);
    }
  };
  createEffect(() => {
    if (group() && tab() === 'members' && !membersLoaded()) loadMembers();
  });

  const removeMember = async (userId) => {
    const g = group();
    if (!g || memberBusy()) return;
    const epoch = loadEpoch;
    setMemberBusy(true);
    try {
      const r = await removeGroupMember(g.id, userId);
      if (epoch !== loadEpoch) return;
      setGroup((cur) => (cur ? { ...cur, member_count: r.member_count } : cur));
      setMembers((cur) => cur.filter((m) => m.user_id !== userId));
    } catch (e) {
      if (epoch !== loadEpoch) return;
      setError(e?.message || 'FAILED TO REMOVE MEMBER');
    } finally {
      if (epoch === loadEpoch) setMemberBusy(false);
    }
  };

  return (
    <div class="h-full flex flex-col font-mono text-sm">
      <Show when={loading()}>
        <div class="p-4 text-bb-muted animate-pulse">RUNNING QUERY...</div>
      </Show>
      <Show when={notFound()}>
        <div class="p-4 text-market-down text-xs">GROUP NOT FOUND</div>
      </Show>
      <Show when={!loading() && !notFound() && error() && !group()}>
        <div class="p-4 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>
      </Show>

      <Show when={group()}>
        <div class="shrink-0 border-b border-bb-border bg-bb-panel px-3 py-2">
          <Show when={error()}>
            <div class="mb-2 p-2 border border-market-down/50 bg-market-down/10 text-market-down text-xxs uppercase">
              ERROR // {error().toUpperCase()}
            </div>
          </Show>
          <div class="flex items-baseline justify-between gap-3">
            <div class="min-w-0">
              <span class="text-bb-accent font-bold text-lg truncate">{group().name}</span>
              <span class="text-bb-muted ml-2 text-xs">// {group().topic_name}</span>
            </div>
            <div class="flex gap-2 text-xs shrink-0">
              <span class="text-bb-muted self-center">{group().member_count ?? 0} MEMBERS</span>
              <Show when={isLoggedIn()}>
                <button
                  type="button"
                  data-testid="group-join"
                  disabled={busy()}
                  onClick={toggleMembership}
                  class={`px-2 py-1 border uppercase font-bold disabled:opacity-50 ${group().is_member ? 'border-bb-border text-bb-muted hover:text-bb-text' : 'border-bb-accent text-bb-accent hover:bg-bb-accent/20'}`}
                >
                  {group().is_member ? '[LEAVE]' : '[JOIN]'}
                </button>
              </Show>
              <Show when={isLoggedIn() && !group().is_owner}>
                <button
                  type="button"
                  data-testid="group-report-toggle"
                  onClick={() => setReportOpen((v) => !v)}
                  class="px-2 py-1 border border-bb-border text-bb-muted hover:text-bb-text uppercase font-bold"
                >
                  [REPORT]
                </button>
              </Show>
            </div>
          </div>
          <Show when={group().description}>
            <p class="text-bb-text text-xs mt-2 whitespace-pre-wrap">{group().description}</p>
          </Show>
          <Show when={reportOpen()}>
            <form onSubmit={submitReport} class="mt-2 flex gap-2 text-xs">
              <input
                type="text"
                data-testid="group-report-reason"
                class="flex-1 bg-bb-bg border border-bb-border px-2 py-1 text-bb-text outline-none"
                placeholder="WHY ARE YOU REPORTING THIS GROUP?"
                value={reportReason()}
                onInput={(e) => setReportReason(e.currentTarget.value)}
              />
              <button
                type="submit"
                data-testid="group-report-submit"
                disabled={reportBusy()}
                class="px-2 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase font-bold disabled:opacity-50"
              >
                [SUBMIT]
              </button>
            </form>
          </Show>
          <Show when={reportMsg()}>
            <div class="mt-1 text-bb-muted text-xxs uppercase">{reportMsg()}</div>
          </Show>
        </div>

        <div class="shrink-0 flex border-b border-bb-border bg-bb-panel text-xs select-none">
          <For each={TABS}>
            {(t) => (
              <button
                type="button"
                onClick={() => setTab(t.key)}
                class={`px-4 py-2 border-r border-bb-border uppercase ${tab() === t.key ? 'bg-bb-accent/15 text-bb-accent font-bold' : 'text-bb-muted hover:text-bb-text hover:bg-white/5'}`}
              >
                [{t.label}]
              </button>
            )}
          </For>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar">
          {/* FEED */}
          <Show when={tab() === 'feed'}>
            <Show
              when={group().is_member}
              fallback={<div class="p-3 text-bb-muted text-xxs uppercase">JOIN THIS GROUP TO POST</div>}
            >
              <div class="p-3 border-b border-bb-border/30 flex gap-2 text-xs">
                <input
                  type="text"
                  data-testid="group-post-input"
                  class="flex-1 bg-bb-bg border border-bb-border px-2 py-1 text-bb-text outline-none"
                  placeholder="POST TO THE GROUP FEED..."
                  value={postText()}
                  disabled={postBusy()}
                  onInput={(e) => setPostText(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitPost(); } }}
                />
                <button
                  type="button"
                  data-testid="group-post-submit"
                  disabled={postBusy() || !postText().trim()}
                  onClick={submitPost}
                  class="px-2 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase font-bold disabled:opacity-50"
                >
                  [POST]
                </button>
              </div>
              <Show when={postError()}>
                <div class="px-3 py-1 text-market-down text-xxs uppercase">{postError()}</div>
              </Show>
            </Show>
            <Show when={!feedLoaded()}>
              <div class="p-3 text-bb-muted animate-pulse text-xs">RUNNING QUERY...</div>
            </Show>
            <Show when={feedLoaded() && posts().length === 0}>
              <div class="p-4 text-bb-muted" data-testid="group-feed-empty">NO POSTS YET</div>
            </Show>
            <For each={posts()}>
              {(p) => (
                <div>
                  <Show when={group().is_owner}>
                    <div class="flex justify-end px-3 py-1 border-b border-bb-border/20">
                      <button
                        type="button"
                        data-testid="group-post-remove"
                        onClick={() => removePost(p.id)}
                        class="px-1.5 py-0.5 border border-market-down/60 text-market-down hover:bg-market-down/20 uppercase text-xxs font-bold"
                      >
                        [REMOVE POST]
                      </button>
                    </div>
                  </Show>
                  <PostItem post={p} disableFeedStore />
                </div>
              )}
            </For>
          </Show>

          {/* CHAT */}
          <Show when={tab() === 'chat'}>
            <div class="flex flex-col h-full">
              <div class="flex-1 p-3 space-y-1">
                <Show when={!chatLoaded()}>
                  <div class="text-bb-muted animate-pulse text-xs">RUNNING QUERY...</div>
                </Show>
                <Show when={chatLoaded() && messages().length === 0}>
                  <div class="text-bb-muted text-xs" data-testid="group-chat-empty">NO MESSAGES YET</div>
                </Show>
                <For each={messages()}>
                  {(m) => (
                    <div data-testid="group-chat-message" class="text-xs">
                      <span class="font-bold text-bb-accent">{m.username || `USER ${m.user_id}`}</span>
                      <span class="text-bb-muted mx-1">//</span>
                      <span class="text-bb-text break-words whitespace-pre-wrap">{m.content}</span>
                    </div>
                  )}
                </For>
              </div>
              <Show
                when={group().is_member}
                fallback={<div class="p-3 border-t border-bb-border/30 text-bb-muted text-xxs uppercase">JOIN THIS GROUP TO CHAT</div>}
              >
                <div class="p-3 border-t border-bb-border/30">
                  <div class="flex gap-2 text-xs">
                    <input
                      type="text"
                      data-testid="group-chat-input"
                      class="flex-1 bg-bb-bg border border-bb-border px-2 py-1 text-bb-text outline-none"
                      placeholder="MESSAGE..."
                      maxlength="1000"
                      value={chatText()}
                      disabled={chatBusy()}
                      onInput={(e) => { setChatText(e.currentTarget.value); setChatError(''); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitChat(); } }}
                    />
                    <button
                      type="button"
                      data-testid="group-chat-submit"
                      disabled={chatBusy() || !chatText().trim()}
                      onClick={submitChat}
                      class="px-2 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase font-bold disabled:opacity-50"
                    >
                      [SEND]
                    </button>
                  </div>
                  <Show when={chatError()}>
                    <div class="mt-1 text-market-down text-xxs" data-testid="group-chat-error">{chatError()}</div>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>

          {/* MARKETS */}
          <Show when={tab() === 'markets'}>
            <Show when={group().is_owner}>
              <div class="p-3 border-b border-bb-border/30 text-xs">
                <input
                  type="text"
                  data-testid="group-market-search"
                  class="w-full bg-bb-bg border border-bb-border px-2 py-1 text-bb-text outline-none"
                  placeholder="SEARCH A MARKET TO PIN..."
                  value={pinQuery()}
                  onInput={onPinInput}
                />
                <Show when={pinResults().length > 0}>
                  <div class="mt-2 space-y-1" data-testid="group-market-search-results">
                    <For each={pinResults()}>
                      {(ev) => (
                        <div class="flex items-center justify-between gap-2 border-b border-bb-border/20 py-1">
                          <span class="truncate">{ev.title}</span>
                          <button
                            type="button"
                            data-testid="group-market-pin"
                            disabled={marketBusy()}
                            onClick={() => pinMarket(ev.id)}
                            class="shrink-0 px-2 py-0.5 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase text-xxs font-bold disabled:opacity-50"
                          >
                            [PIN]
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={!marketsLoaded()}>
              <div class="p-3 text-bb-muted animate-pulse text-xs">RUNNING QUERY...</div>
            </Show>
            <Show when={marketsLoaded() && markets().length === 0}>
              <div class="p-4 text-bb-muted" data-testid="group-markets-empty">NO MARKETS PINNED YET</div>
            </Show>
            <For each={markets()}>
              {(m) => (
                <div
                  data-testid="group-market-row"
                  onClick={() => { window.location.hash = `#predictions/${m.event_id}`; }}
                  class="px-3 py-2 border-b border-bb-border/20 text-xs cursor-pointer hover:bg-white/5 flex items-center justify-between gap-3"
                >
                  <span class="truncate font-bold">{m.title}</span>
                  <div class="flex items-center gap-2 shrink-0 text-bb-muted">
                    <span>{m.outcome ? `RESOLVED: ${m.outcome}` : `PROB ${pct(m.market_prob)}`}</span>
                    <span>{m.closing_date ? `CLOSES ${day(m.closing_date)}` : ''}</span>
                    <Show when={group().is_owner}>
                      <button
                        type="button"
                        data-testid="group-market-unpin"
                        disabled={marketBusy()}
                        onClick={(e) => { e.stopPropagation(); unpinMarket(m.event_id); }}
                        class="px-2 py-0.5 border border-bb-border text-bb-muted hover:text-market-down uppercase text-xxs font-bold disabled:opacity-50"
                      >
                        [UNPIN]
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>

          {/* MEMBERS */}
          <Show when={tab() === 'members'}>
            <Show when={!membersLoaded()}>
              <div class="p-3 text-bb-muted animate-pulse text-xs">RUNNING QUERY...</div>
            </Show>
            <For each={members()}>
              {(m) => (
                <div
                  data-testid="group-member-row"
                  class="px-3 py-2 border-b border-bb-border/20 text-xs flex items-center justify-between gap-3 hover:bg-white/5"
                >
                  <button
                    type="button"
                    class="font-bold text-left truncate hover:text-bb-accent"
                    onClick={() => { window.location.hash = `#user/${m.user_id}`; }}
                  >
                    @{m.username}
                  </button>
                  <div class="flex items-center gap-2 shrink-0">
                    <Show when={m.role === 'owner'}>
                      <span class="text-bb-tmux uppercase text-xxs font-bold">[OWNER]</span>
                    </Show>
                    <Show when={group().is_owner && m.role !== 'owner'}>
                      <button
                        type="button"
                        data-testid="group-member-remove"
                        disabled={memberBusy()}
                        onClick={() => removeMember(m.user_id)}
                        class="px-2 py-0.5 border border-market-down/60 text-market-down hover:bg-market-down/20 uppercase text-xxs font-bold disabled:opacity-50"
                      >
                        [REMOVE]
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
