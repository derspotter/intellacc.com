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
