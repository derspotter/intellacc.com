const db = require('../db');

const mlsService = {
  async upsertKeyPackage(userId, deviceId, packageData, hash) {
    const query = `
      INSERT INTO mls_key_packages (user_id, device_id, package_data, hash, last_updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, device_id)
      DO UPDATE SET package_data = $3, hash = $4, last_updated_at = NOW()
      RETURNING *;
    `;
    const { rows } = await db.query(query, [userId, deviceId, packageData, hash]);
    return rows[0];
  },

  async getKeyPackage(userId) {
    const query = `
      SELECT * FROM mls_key_packages WHERE user_id = $1 ORDER BY last_updated_at DESC LIMIT 1;
    `;
    const { rows } = await db.query(query, [userId]);
    return rows[0];
  },

  async storeWelcomeMessage(groupId, receiverId, data) {
    const query = `
      INSERT INTO mls_welcome_messages (group_id, receiver_id, data)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const { rows } = await db.query(query, [groupId, receiverId, data]);
    return rows[0];
  },

  async getWelcomeMessages(userId) {
    const query = `
      SELECT * FROM mls_welcome_messages WHERE receiver_id = $1 ORDER BY created_at ASC;
    `;
    const { rows } = await db.query(query, [userId]);
    return rows;
  },

  async deleteWelcomeMessage(id) {
    const query = 'DELETE FROM mls_welcome_messages WHERE id = $1';
    await db.query(query, [id]);
  },

  async storeGroupMessage(groupId, senderId, epoch, contentType, data) {
    // TODO: Add locking or check for strict ordering if needed by MLS
    const query = `
      INSERT INTO mls_group_messages (group_id, sender_id, epoch, content_type, data)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const { rows } = await db.query(query, [groupId, senderId, epoch, contentType, data]);
    return rows[0];
  },

  async getGroupMessages(groupId, afterId = 0) {
    const query = `
      SELECT * FROM mls_group_messages 
      WHERE group_id = $1 AND id > $2 
      ORDER BY id ASC;
    `;
    const { rows } = await db.query(query, [groupId, afterId]);
    return rows;
  },

  async createGroup(groupId, name, createdBy) {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');

      // Create group
      const groupQuery = `
            INSERT INTO mls_groups (group_id, name, created_by)
            VALUES ($1, $2, $3)
            RETURNING *;
        `;
      const { rows: [group] } = await client.query(groupQuery, [groupId, name, createdBy]);

      // Add creator as member
      const memberQuery = `
            INSERT INTO mls_group_members (group_id, user_id)
            VALUES ($1, $2);
        `;
      await client.query(memberQuery, [groupId, createdBy]);

      await client.query('COMMIT');
      return group;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async addGroupMember(groupId, userId) {
    const query = `
      INSERT INTO mls_group_members (group_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (group_id, user_id) DO NOTHING
      RETURNING *;
    `;
    const { rows } = await db.query(query, [groupId, userId]);
    return rows[0];
  }
};

module.exports = mlsService;
