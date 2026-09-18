// In-memory fake of the pg pool for the AI assistant tests. Only the SQL the
// AI services issue is modelled; anything else throws so a new query cannot
// silently pass. Tests run with --network none, so no real database exists.
const crypto = require('crypto');

const STALE_MS = 300 * 1000;
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

const createFakeDb = () => {
  const state = {
    settings: new Map(),
    conversations: new Map(),
    messages: new Map(),
    requests: new Map(),
    usage: [],
    posts: new Map(),
    users: new Map(),
    blocks: [],
    members: [],
    jobs: new Map(),
    calls: []
  };
  let nextId = 1000;
  const id = () => { nextId += 1; return nextId; };

  const visible = (post, viewerId) => {
    if (!post || post.is_hidden) return false;
    if (viewerId == null) return true;
    return !state.blocks.some((b) =>
      (b.blocker_id === post.user_id && b.blocked_user_id === viewerId) ||
      (b.blocker_id === viewerId && b.blocked_user_id === post.user_id));
  };
  const isStale = (ts) => ts != null && (Date.now() - new Date(ts).getTime()) > STALE_MS;
  const rows = (list) => ({ rows: list, rowCount: list.length });

  const handlers = [
    [/^(BEGIN|COMMIT|ROLLBACK)$/, () => rows([])],

    // --- settings / credentials ---
    [/SELECT provider, model, key_ciphertext, key_hint, public_replies FROM user_ai_settings WHERE user_id = \$1/, ([u]) => rows(state.settings.has(u) ? [state.settings.get(u)] : [])],
    [/SELECT provider, key_ciphertext, key_hint FROM user_ai_settings WHERE user_id = \$1/, ([u]) => rows(state.settings.has(u) ? [state.settings.get(u)] : [])],
    [/SELECT provider, model, key_ciphertext, public_replies FROM user_ai_settings WHERE user_id = \$1/, ([u]) => rows(state.settings.has(u) ? [state.settings.get(u)] : [])],
    [/SELECT user_id FROM user_ai_settings WHERE user_id = \$1 FOR UPDATE/, ([u]) => rows(state.settings.has(u) ? [{ user_id: u }] : [])],
    [/INSERT INTO user_ai_settings/, ([u, provider, model, key_ciphertext, key_hint, public_replies]) => {
      const row = { user_id: u, provider, model, key_ciphertext, key_hint, public_replies };
      state.settings.set(u, row);
      return rows([row]);
    }],
    [/DELETE FROM user_ai_settings WHERE user_id = \$1/, ([u]) => { state.settings.delete(u); return rows([]); }],

    // --- budget ---
    [/AS active/, ([u]) => {
      const convs = [...state.conversations.values()].filter((c) => c.user_id === u && c.generation_request_id && !isStale(c.generation_started_at)).length;
      const jobs = [...state.jobs.values()].filter((j) => j.requester_user_id === u && j.status === 'running' && j.locked_until > new Date()).length;
      const tests = state.usage.filter((e) => e.user_id === u && e.active_until && e.active_until > new Date()).length;
      return rows([{ active: convs + jobs + tests }]);
    }],
    [/AS hour/, ([u]) => {
      const now = Date.now();
      const mine = state.usage.filter((e) => e.user_id === u && now - e.at < 24 * 3600 * 1000);
      return rows([{ hour: mine.filter((e) => now - e.at < 3600 * 1000).length, day: mine.length }]);
    }],
    [/INSERT INTO ai_usage_events/, ([u, kind]) => {
      const row = { id: id(), user_id: u, kind, at: Date.now(), active_until: kind === 'test' ? new Date(Date.now() + 180000) : null };
      state.usage.push(row);
      return rows([{ id: row.id }]);
    }],
    [/UPDATE ai_usage_events SET active_until/, ([eid]) => { const e = state.usage.find((x) => x.id === eid); if (e) e.active_until = null; return rows([]); }],

    // --- conversations ---
    [/FROM ai_conversations WHERE user_id = \$1 ORDER BY/, ([u, limit]) => rows([...state.conversations.values()].filter((c) => c.user_id === u).sort((a, b) => b.updated_at - a.updated_at).slice(0, limit))],
    [/INSERT INTO ai_conversations/, ([u, post_id, title]) => {
      const row = { id: id(), user_id: u, post_id, title, generation_request_id: null, generation_started_at: null, updated_at: new Date() };
      state.conversations.set(row.id, row);
      return rows([{ id: row.id, title: row.title, post_id: row.post_id }]);
    }],
    [/SELECT id, title, post_id FROM ai_conversations WHERE id = \$1 AND user_id = \$2/, ([cid, u]) => {
      const c = state.conversations.get(cid);
      return rows(c && c.user_id === u ? [{ id: c.id, title: c.title, post_id: c.post_id }] : []);
    }],
    [/FROM ai_conversations WHERE id = \$1 AND user_id = \$2 FOR UPDATE/, ([cid, u]) => {
      const c = state.conversations.get(cid);
      return rows(c && c.user_id === u ? [{ ...c, generation_stale: isStale(c.generation_started_at) }] : []);
    }],
    [/DELETE FROM ai_conversations WHERE id = \$1 AND user_id = \$2/, ([cid, u]) => {
      const c = state.conversations.get(cid);
      if (!c || c.user_id !== u) return rows([]);
      if (c.generation_request_id && !isStale(c.generation_started_at)) return rows([]);
      state.conversations.delete(cid);
      return rows([{ id: cid }]);
    }],
    [/SELECT 1 FROM ai_conversations WHERE id = \$1 AND user_id = \$2/, ([cid, u]) => {
      const c = state.conversations.get(cid);
      return rows(c && c.user_id === u ? [{ '?column?': 1 }] : []);
    }],
    [/UPDATE ai_conversations SET generation_request_id = \$2, generation_started_at = NOW\(\)/, ([cid, rid]) => {
      Object.assign(state.conversations.get(cid), { generation_request_id: rid, generation_started_at: new Date() });
      return rows([]);
    }],
    [/UPDATE ai_conversations SET generation_request_id = NULL, generation_started_at = NULL, updated_at = NOW\(\), title = COALESCE/, ([cid, title]) => {
      const c = state.conversations.get(cid);
      Object.assign(c, { generation_request_id: null, generation_started_at: null, updated_at: new Date(), title: c.title ?? title });
      return rows([]);
    }],
    [/UPDATE ai_conversations SET generation_request_id = NULL, generation_started_at = NULL WHERE id = \$1 AND generation_request_id = \$2/, ([cid, rid]) => {
      const c = state.conversations.get(cid);
      if (c && c.generation_request_id === rid) Object.assign(c, { generation_request_id: null, generation_started_at: null });
      return rows([]);
    }],

    // --- messages ---
    [/FROM ai_messages WHERE conversation_id = \$1 AND status <> 'pending'/, ([cid, limit]) => rows([...state.messages.values()].filter((m) => m.conversation_id === cid && m.status !== 'pending').sort((a, b) => a.id - b.id).slice(-limit))],
    [/FROM ai_messages WHERE conversation_id = \$1 AND status = 'ok'/, ([cid, limit]) => rows([...state.messages.values()].filter((m) => m.conversation_id === cid && m.status === 'ok').sort((a, b) => a.id - b.id).slice(-limit))],
    [/FROM ai_messages WHERE id = ANY/, ([ids]) => rows(ids.map((i) => state.messages.get(i)).filter(Boolean).sort((a, b) => a.id - b.id))],
    [/INSERT INTO ai_messages \(conversation_id, role, content, status, request_id\)/, ([cid, content, rid]) => {
      const row = { id: id(), conversation_id: cid, role: 'user', content, model: null, status: 'pending', error_code: null, request_id: rid, created_at: new Date() };
      state.messages.set(row.id, row);
      return rows([row]);
    }],
    [/INSERT INTO ai_messages \(conversation_id, role, content, model, status, request_id\)/, ([cid, content, model, rid]) => {
      const row = { id: id(), conversation_id: cid, role: 'assistant', content, model, status: 'ok', error_code: null, request_id: rid, created_at: new Date() };
      state.messages.set(row.id, row);
      return rows([row]);
    }],
    [/UPDATE ai_messages SET status = \$2, error_code = \$3 WHERE id = \$1/, ([mid, status, code]) => {
      const m = state.messages.get(mid);
      if (m) Object.assign(m, { status, error_code: code });
      return rows([]);
    }],
    [/UPDATE ai_messages SET status = 'ok' WHERE id = \$1/, ([mid]) => { state.messages.get(mid).status = 'ok'; return rows([]); }],

    // --- idempotency requests ---
    [/FROM ai_conversation_requests WHERE conversation_id = \$1 AND request_id = \$2/, ([cid, rid]) => {
      const r = state.requests.get(`${cid}:${rid}`);
      return rows(r ? [{ ...r, stale: isStale(r.updated_at) }] : []);
    }],
    [/INSERT INTO ai_conversation_requests/, ([cid, rid, umid]) => {
      const key = `${cid}:${rid}`;
      if (state.requests.has(key)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      state.requests.set(key, { conversation_id: cid, request_id: rid, status: 'running', user_message_id: umid, assistant_message_id: null, error_code: null, updated_at: new Date() });
      return rows([]);
    }],
    [/UPDATE ai_conversation_requests SET status = 'failed'/, ([cid, rid, code]) => {
      const r = state.requests.get(`${cid}:${rid}`);
      if (r) Object.assign(r, { status: 'failed', error_code: code, updated_at: new Date() });
      return rows([]);
    }],
    [/UPDATE ai_conversation_requests SET status = 'succeeded'/, ([cid, rid, amid]) => {
      Object.assign(state.requests.get(`${cid}:${rid}`), { status: 'succeeded', assistant_message_id: amid, updated_at: new Date() });
      return rows([]);
    }],

    // --- posts / thread ---
    // Ancestor chain shared by the private drawer (ai_level) and the public
    // worker (level): trigger first, root last, each row flagged visible.
    [/AS ai_level/, ([pid, viewer]) => {
      const out = [];
      let current = state.posts.get(pid);
      while (current) {
        const author = state.users.get(current.user_id) || {};
        const member = !current.community_group_id || state.members.some((m) => m.group_id === current.community_group_id && m.user_id === viewer);
        out.push({ id: current.id, parent_id: current.parent_id, content: current.content, community_group_id: current.community_group_id, username: author.username, visible: !author.deleted_at && visible(current, viewer) && member });
        current = current.parent_id ? state.posts.get(current.parent_id) : null;
      }
      return rows(out);
    }],
    [/WITH RECURSIVE chain/, ([pid, viewer]) => {
      const out = [];
      let current = state.posts.get(pid);
      let level = 0;
      while (current) {
        const author = state.users.get(current.user_id) || {};
        out.push({ ...current, level, username: author.username, visible: !author.deleted_at && visible(current, viewer) });
        current = current.parent_id ? state.posts.get(current.parent_id) : null;
        level += 1;
      }
      return rows(out);
    }],
    [/SELECT id FROM ai_conversations WHERE id = \$1 AND generation_request_id = \$2 FOR UPDATE/, ([cid, rid]) => {
      const c = state.conversations.get(cid);
      return rows(c && c.generation_request_id === rid ? [{ id: cid }] : []);
    }],
    [/SELECT id, user_id, is_hidden, is_comment, depth FROM posts WHERE id = \$1 FOR UPDATE/, ([pid]) => rows(state.posts.has(pid) ? [state.posts.get(pid)] : [])],
    [/INSERT INTO posts/, ([user_id, content, parent_id, depth]) => {
      const row = { id: id(), user_id, content, parent_id, depth, is_comment: true, is_bot: true, is_hidden: false, community_group_id: null, comment_count: 0, created_at: new Date() };
      state.posts.set(row.id, row);
      return rows([row]);
    }],
    [/UPDATE posts SET comment_count = comment_count \+ 1/, ([pid]) => { state.posts.get(pid).comment_count += 1; return rows([]); }],
    [/SELECT id, username FROM users WHERE system_bot_key = \$1/, ([key]) => rows([...state.users.values()].filter((u) => u.system_bot_key === key && !u.deleted_at))],

    // --- public reply jobs ---
    [/INSERT INTO ai_public_reply_jobs \(post_id, requester_user_id, status, error_code\)/, ([pid, u, code]) => {
      if (!state.jobs.has(pid)) state.jobs.set(pid, { post_id: pid, requester_user_id: u, status: 'declined', error_code: code, reply_post_id: null, model: null, lease_id: null, locked_until: null, attempts: 0, created_at: new Date(), updated_at: new Date() });
      return rows([]);
    }],
    [/INSERT INTO ai_public_reply_jobs \(post_id, requester_user_id, status\)/, ([pid, u]) => {
      if (state.jobs.has(pid)) return rows([]);
      state.jobs.set(pid, { post_id: pid, requester_user_id: u, status: 'queued', error_code: null, reply_post_id: null, model: null, lease_id: null, locked_until: null, attempts: 0, created_at: new Date(), updated_at: new Date() });
      return rows([{ post_id: pid }]);
    }],
    [/FROM ai_public_reply_jobs WHERE post_id = \$1 AND requester_user_id = \$2/, ([pid, u]) => {
      const j = state.jobs.get(pid);
      return rows(j && j.requester_user_id === u ? [j] : []);
    }],
    [/UPDATE ai_public_reply_jobs SET status = 'failed', error_code = 'interrupted'/, () => {
      const expired = [...state.jobs.values()].filter((j) => j.status === 'running' && j.locked_until < new Date());
      expired.forEach((j) => Object.assign(j, { status: 'failed', error_code: 'interrupted', lease_id: null, locked_until: null }));
      return rows(expired.map((j) => ({ post_id: j.post_id, requester_user_id: j.requester_user_id })));
    }],
    [/UPDATE ai_public_reply_jobs SET status = 'failed', error_code = \$3/, ([pid, lease, code]) => {
      const j = state.jobs.get(pid);
      if (j && j.lease_id === lease && j.status === 'running') Object.assign(j, { status: 'failed', error_code: code, lease_id: null, locked_until: null });
      return rows([]);
    }],
    [/WITH ready AS/, ([limit, lease, seconds]) => {
      const claimed = [...state.jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.created_at - b.created_at).slice(0, limit);
      claimed.forEach((j) => Object.assign(j, { status: 'running', lease_id: lease, locked_until: new Date(Date.now() + seconds * 1000), attempts: j.attempts + 1 }));
      return rows(claimed.map((j) => ({ ...j })));
    }],
    [/FROM ai_public_reply_jobs WHERE post_id = \$1 AND lease_id = \$2 AND status = 'running' FOR UPDATE/, ([pid, lease]) => {
      const j = state.jobs.get(pid);
      return rows(j && j.lease_id === lease && j.status === 'running' ? [{ post_id: pid }] : []);
    }],
    [/UPDATE ai_public_reply_jobs SET status = 'published'/, ([pid, lease, replyId, model]) => {
      const j = state.jobs.get(pid);
      if (j && j.lease_id === lease) Object.assign(j, { status: 'published', reply_post_id: replyId, model, lease_id: null, locked_until: null });
      return rows([]);
    }]
  ];

  const query = jest.fn(async (sql, params = []) => {
    const text = norm(sql);
    state.calls.push({ sql: text, params });
    for (const [pattern, handler] of handlers) {
      if (pattern.test(text)) return handler(params);
    }
    throw new Error(`Unhandled SQL in fake db: ${text.slice(0, 120)}`);
  });
  const client = { query, release: jest.fn() };
  const pool = { connect: async () => client, query, options: {} };

  return {
    query,
    getPool: () => pool,
    closePool: async () => {},
    executeWithTransaction: async (fn) => fn(client),
    state,
    addUser: (row) => { state.users.set(row.id, { ...row }); return row.id; },
    addPost: (row) => {
      const post = { is_hidden: false, is_comment: Boolean(row.parent_id), depth: 0, community_group_id: null, comment_count: 0, parent_id: null, created_at: new Date(), ...row };
      state.posts.set(post.id, post);
      return post;
    },
    sqlTouching: (table) => state.calls.filter((c) => c.sql.includes(table))
  };
};

const TEST_SECRET = crypto.createHash('sha256').update('ai-assistant-test-secret').digest().toString('base64');

module.exports = { createFakeDb, TEST_SECRET, STALE_MS };
