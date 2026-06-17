const db = require('../db');

const NAME_MIN = 3;
const NAME_MAX = 80;
const DESC_MAX = 500;

const getViewerId = (req) => req.user?.id || req.user?.userId || null;

const slugify = (name) => {
  const base = String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${base || 'group'}-${rand}`;
};

const mapGroup = (row, viewerId) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  topic_id: row.topic_id,
  topic_name: row.topic_name,
  member_count: row.member_count,
  created_by: row.created_by,
  is_member: !!row.is_member,
  is_owner: viewerId != null && Number(row.created_by) === Number(viewerId)
});

exports.listGroups = async (req, res) => {
  const viewerId = getViewerId(req);
  const sort = req.query.sort === 'recent' ? 'g.created_at DESC, g.id DESC' : 'g.member_count DESC, g.id DESC';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const params = [viewerId];
  let where = 'g.removed_at IS NULL';
  const topicId = parseInt(req.query.topic, 10);
  if (Number.isInteger(topicId)) { params.push(topicId); where += ` AND g.topic_id = $${params.length}`; }
  params.push(limit);
  try {
    const result = await db.query(
      `SELECT g.id, g.slug, g.name, g.description, g.topic_id, t.name AS topic_name,
              g.member_count, g.created_by,
              EXISTS (SELECT 1 FROM community_group_members m WHERE m.group_id = g.id AND m.user_id = $1) AS is_member
       FROM community_groups g JOIN topics t ON t.id = g.topic_id
       WHERE ${where}
       ORDER BY ${sort}
       LIMIT $${params.length}`,
      params
    );
    res.json({ groups: result.rows.map((r) => mapGroup(r, viewerId)) });
  } catch (err) {
    console.error('Error listing groups:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  try {
    const result = await db.query(
      `SELECT g.id, g.slug, g.name, g.description, g.topic_id, t.name AS topic_name,
              g.member_count, g.created_by,
              EXISTS (SELECT 1 FROM community_group_members m WHERE m.group_id = g.id AND m.user_id = $2) AS is_member
       FROM community_groups g JOIN topics t ON t.id = g.topic_id
       WHERE g.slug = $1 AND g.removed_at IS NULL`,
      [req.params.slug, viewerId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    res.json({ group: mapGroup(result.rows[0], viewerId) });
  } catch (err) {
    console.error('Error getting group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.createGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const topicId = parseInt(req.body?.topic_id, 10);
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return res.status(400).json({ message: `Name must be ${NAME_MIN}-${NAME_MAX} characters` });
  }
  if (description.length > DESC_MAX) {
    return res.status(400).json({ message: `Description must be at most ${DESC_MAX} characters` });
  }
  if (!Number.isInteger(topicId)) {
    return res.status(400).json({ message: 'A topic is required' });
  }
  try {
    const group = await db.executeWithTransaction(async (client) => {
      const topic = await client.query('SELECT id, name FROM topics WHERE id = $1', [topicId]);
      if (topic.rows.length === 0) { const e = new Error('Topic not found'); e.status = 400; throw e; }
      const ins = await client.query(
        `INSERT INTO community_groups (slug, name, description, topic_id, created_by, member_count)
         VALUES ($1, $2, $3, $4, $5, 1)
         RETURNING id, slug, name, description, topic_id, member_count, created_by`,
        [slugify(name), name, description, topicId, viewerId]
      );
      const g = ins.rows[0];
      await client.query(
        `INSERT INTO community_group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [g.id, viewerId]
      );
      g.topic_name = topic.rows[0].name;
      g.is_member = true;
      return g;
    });
    res.status(201).json({ group: mapGroup(group, viewerId) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    console.error('Error creating group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.joinGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  try {
    const memberCount = await db.executeWithTransaction(async (client) => {
      const g = await client.query('SELECT id FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
      if (g.rows.length === 0) { const e = new Error('Group not found'); e.status = 404; throw e; }
      const ins = await client.query(
        `INSERT INTO community_group_members (group_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, viewerId]
      );
      if (ins.rowCount === 1) {
        await client.query('UPDATE community_groups SET member_count = member_count + 1 WHERE id = $1', [groupId]);
      }
      const cnt = await client.query('SELECT member_count FROM community_groups WHERE id = $1', [groupId]);
      return cnt.rows[0].member_count;
    });
    res.json({ is_member: true, member_count: memberCount });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error('Error joining group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.leaveGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  try {
    const memberCount = await db.executeWithTransaction(async (client) => {
      const del = await client.query(
        'DELETE FROM community_group_members WHERE group_id = $1 AND user_id = $2', [groupId, viewerId]
      );
      if (del.rowCount === 1) {
        await client.query('UPDATE community_groups SET member_count = GREATEST(0, member_count - 1) WHERE id = $1', [groupId]);
      }
      const cnt = await client.query('SELECT member_count FROM community_groups WHERE id = $1', [groupId]);
      return cnt.rows[0]?.member_count ?? 0;
    });
    res.json({ is_member: false, member_count: memberCount });
  } catch (err) {
    console.error('Error leaving group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.searchGroups = async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ groups: [] });
  const params = [`%${q}%`];
  let where = 'g.removed_at IS NULL AND g.name ILIKE $1';
  const topicId = parseInt(req.query.topic, 10);
  if (Number.isInteger(topicId)) { params.push(topicId); where += ` AND g.topic_id = $${params.length}`; }
  try {
    const result = await db.query(
      `SELECT g.id, g.slug, g.name, g.member_count FROM community_groups g
       WHERE ${where} ORDER BY g.member_count DESC LIMIT 5`,
      params
    );
    res.json({ groups: result.rows });
  } catch (err) {
    console.error('Error searching groups:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.deleteGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  const isAdmin = req.user?.role === 'admin';
  try {
    const g = await db.query('SELECT created_by FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    if (Number(g.rows[0].created_by) !== Number(viewerId) && !isAdmin) {
      return res.status(403).json({ message: 'Only the owner or an admin can remove this group' });
    }
    await db.query('UPDATE community_groups SET removed_at = NOW() WHERE id = $1', [groupId]);
    res.json({ removed: true });
  } catch (err) {
    console.error('Error removing group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getGroupPosts = async (req, res) => {
  const viewerId = getViewerId(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE slug = $1 AND removed_at IS NULL', [req.params.slug]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const groupId = g.rows[0].id;
    const params = [groupId, viewerId];
    let cursor = '';
    if (req.query.before) {
      params.push(req.query.before, parseInt(req.query.beforeId, 10) || 0);
      cursor = ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(limit + 1);
    const result = await db.query(
      `SELECT p.id, p.user_id, u.username, u.avatar_url, p.content, p.image_url, p.created_at,
              p.like_count, p.comment_count,
              CASE WHEN EXISTS (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $2) THEN true ELSE false END AS liked_by_user,
              (SELECT COUNT(*)::int FROM posts rpc WHERE rpc.repost_id = p.id) AS repost_count,
              CASE WHEN EXISTS (SELECT 1 FROM posts rpu WHERE rpu.repost_id = p.id AND rpu.user_id = $2) THEN true ELSE false END AS reposted_by_user
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.community_group_id = $1${cursor}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${params.length}`,
      params
    );
    const rows = result.rows;
    const hasMore = rows.length > limit;
    res.json({ posts: hasMore ? rows.slice(0, limit) : rows, hasMore });
  } catch (err) {
    console.error('Error listing group posts:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getGroupMessages = async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE slug = $1 AND removed_at IS NULL', [req.params.slug]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const result = await db.query(
      `SELECT m.id, m.user_id, u.username, m.content, m.created_at
       FROM community_group_messages m JOIN users u ON u.id = m.user_id
       WHERE m.group_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
      [g.rows[0].id, limit]
    );
    res.json({ messages: result.rows.reverse() });
  } catch (err) {
    console.error('Error listing group messages:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.postGroupMessage = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  const content = String(req.body?.content || '').trim();
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  if (!content) return res.status(400).json({ message: 'Message cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ message: 'Message too long (max 1000)' });
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const mem = await db.query('SELECT 1 FROM community_group_members WHERE group_id = $1 AND user_id = $2', [groupId, viewerId]);
    if (mem.rows.length === 0) return res.status(403).json({ message: 'Join the group to chat' });
    const ins = await db.query(
      `INSERT INTO community_group_messages (group_id, user_id, content) VALUES ($1, $2, $3)
       RETURNING id, user_id, content, created_at`,
      [groupId, viewerId, content]
    );
    const u = await db.query('SELECT username FROM users WHERE id = $1', [viewerId]);
    const message = { ...ins.rows[0], username: u.rows[0]?.username || `user-${viewerId}` };
    const io = req.app.get('io');
    if (io) io.to(`group-chat:${groupId}`).emit('group-message', message);
    res.status(201).json({ message });
  } catch (err) {
    console.error('Error posting group message:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Load a group's created_by and assert the viewer may manage it (owner or admin).
const assertCanManage = async (groupId, req) => {
  const g = await db.query('SELECT created_by FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
  if (g.rows.length === 0) return { error: 404, message: 'Group not found' };
  const viewerId = getViewerId(req);
  if (Number(g.rows[0].created_by) !== Number(viewerId) && req.user?.role !== 'admin') {
    return { error: 403, message: 'Only the owner or an admin can manage this group' };
  }
  return { ok: true };
};

exports.getGroupMarkets = async (req, res) => {
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE slug = $1 AND removed_at IS NULL', [req.params.slug]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const result = await db.query(
      `SELECT cgm.event_id, e.title, e.market_prob, e.closing_date, e.outcome
       FROM community_group_markets cgm JOIN events e ON e.id = cgm.event_id
       WHERE cgm.group_id = $1 ORDER BY cgm.pinned_at DESC`,
      [g.rows[0].id]
    );
    res.json({ markets: result.rows });
  } catch (err) {
    console.error('Error listing group markets:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.pinGroupMarket = async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const eventId = parseInt(req.body?.event_id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  if (!Number.isInteger(eventId)) return res.status(400).json({ message: 'Invalid event id' });
  try {
    const can = await assertCanManage(groupId, req);
    if (can.error) return res.status(can.error).json({ message: can.message });
    const ev = await db.query('SELECT id FROM events WHERE id = $1', [eventId]);
    if (ev.rows.length === 0) return res.status(404).json({ message: 'Market not found' });
    await db.query(
      `INSERT INTO community_group_markets (group_id, event_id, pinned_by) VALUES ($1, $2, $3)
       ON CONFLICT (group_id, event_id) DO NOTHING`,
      [groupId, eventId, getViewerId(req)]
    );
    res.json({ pinned: true });
  } catch (err) {
    console.error('Error pinning market:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.unpinGroupMarket = async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const eventId = parseInt(req.params.eventId, 10);
  if (!Number.isInteger(groupId) || !Number.isInteger(eventId)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const can = await assertCanManage(groupId, req);
    if (can.error) return res.status(can.error).json({ message: can.message });
    await db.query('DELETE FROM community_group_markets WHERE group_id = $1 AND event_id = $2', [groupId, eventId]);
    res.json({ pinned: false });
  } catch (err) {
    console.error('Error unpinning market:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.listGroupMembers = async (req, res) => {
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE slug = $1 AND removed_at IS NULL', [req.params.slug]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const result = await db.query(
      `SELECT m.user_id, u.username, m.role
       FROM community_group_members m JOIN users u ON u.id = m.user_id
       WHERE m.group_id = $1 ORDER BY (m.role = 'owner') DESC, m.joined_at ASC`,
      [g.rows[0].id]
    );
    res.json({ members: result.rows });
  } catch (err) {
    console.error('Error listing members:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.reportGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  const reason = String(req.body?.reason || '').trim();
  const details = String(req.body?.details || '').trim() || null;
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  if (!reason) return res.status(400).json({ message: 'Report reason is required' });
  try {
    const g = await db.query('SELECT created_by FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    if (Number(g.rows[0].created_by) === Number(viewerId)) return res.status(400).json({ message: "You can't report your own group" });
    await db.query(
      `INSERT INTO moderation_reports (reporter_id, reported_user_id, reported_content_type, reported_content_id, report_reason, details)
       VALUES ($1, $2, 'group', $3, $4, $5)`,
      [viewerId, g.rows[0].created_by, groupId, reason, details]
    );
    res.status(201).json({ reported: true });
  } catch (err) {
    console.error('Error reporting group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.removeGroupPost = async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const postId = parseInt(req.params.postId, 10);
  if (!Number.isInteger(groupId) || !Number.isInteger(postId)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const can = await assertCanManage(groupId, req);
    if (can.error) return res.status(can.error).json({ message: can.message });
    const p = await db.query('SELECT id, community_group_id FROM posts WHERE id = $1', [postId]);
    if (p.rows.length === 0) return res.status(404).json({ message: 'Post not found' });
    if (Number(p.rows[0].community_group_id) !== groupId) return res.status(400).json({ message: 'Post is not in this group' });
    await db.query('DELETE FROM posts WHERE id = $1', [postId]);
    res.json({ removed: true });
  } catch (err) {
    console.error('Error removing group post:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.removeMember = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(groupId) || !Number.isInteger(userId)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const g = await db.query('SELECT created_by FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    if (Number(g.rows[0].created_by) !== Number(viewerId) && req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Only the owner or an admin can remove members' });
    }
    if (Number(g.rows[0].created_by) === Number(userId)) return res.status(400).json({ message: "You can't remove the owner" });
    const memberCount = await db.executeWithTransaction(async (client) => {
      const del = await client.query('DELETE FROM community_group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
      if (del.rowCount === 1) {
        await client.query('UPDATE community_groups SET member_count = GREATEST(0, member_count - 1) WHERE id = $1', [groupId]);
      }
      const c = await client.query('SELECT member_count FROM community_groups WHERE id = $1', [groupId]);
      return c.rows[0]?.member_count ?? 0;
    });
    res.json({ removed: true, member_count: memberCount });
  } catch (err) {
    console.error('Error removing member:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
