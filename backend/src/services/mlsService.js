const db = require('../db');

let io = null;

const mlsService = {
  setSocketIo(socketIo) {
    io = socketIo;
    console.log('[MLS] Socket.IO instance set');
  },

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

  async isGroupMember(groupId, userId) {
    const query = `
      SELECT 1 FROM mls_group_members WHERE group_id = $1 AND user_id = $2;
    `;
    const { rows } = await db.query(query, [groupId, userId]);
    return rows.length > 0;
  },

  async storeWelcomeMessage(groupId, senderId, receiverId, data) {
    const query = `
      INSERT INTO mls_welcome_messages (group_id, sender_id, receiver_id, data)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const { rows } = await db.query(query, [groupId, senderId, receiverId, data]);
    const welcome = rows[0];

    // Emit socket event to receiver for real-time notification
    if (io) {
      io.to(`mls:${receiverId}`).emit('mls-welcome', {
        id: welcome.id,
        groupId: welcome.group_id,
        senderId: welcome.sender_id
      });
      console.log(`[MLS] Emitted mls-welcome to mls:${receiverId} from sender ${senderId}`);
    }

    return welcome;
  },

  async getWelcomeMessages(userId) {
    const query = `
      SELECT w.*, u.username as sender_username
      FROM mls_welcome_messages w
      LEFT JOIN users u ON w.sender_id = u.id
      WHERE w.receiver_id = $1
      ORDER BY w.created_at ASC;
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
    const message = rows[0];

    // Emit socket event to all group members
    if (io) {
      // Get all group members
      const membersQuery = `SELECT user_id FROM mls_group_members WHERE group_id = $1`;
      const { rows: members } = await db.query(membersQuery, [groupId]);

      // Emit to each member's MLS room (except sender for application messages)
      for (const member of members) {
        // For application messages, don't echo back to sender
        if (contentType === 'application' && member.user_id === senderId) continue;

        io.to(`mls:${member.user_id}`).emit('mls-message', {
          id: message.id,
          groupId: message.group_id,
          senderId: message.sender_id,
          contentType: message.content_type,
          epoch: message.epoch
        });
      }
      console.log(`[MLS] Emitted mls-message to ${members.length} members of group ${groupId}`);
    }

    return message;
  },

  async getGroupMessages(groupId, afterId = 0, userId = null) {
    // If userId is provided, only return messages created AFTER the user joined
    // This prevents newly joined members from receiving commits they already processed via Welcome
    let query;
    let params;

    if (userId) {
      query = `
        SELECT m.* FROM mls_group_messages m
        JOIN mls_group_members gm ON gm.group_id = m.group_id AND gm.user_id = $3
        WHERE m.group_id = $1 AND m.id > $2 AND m.created_at > gm.joined_at
        ORDER BY m.id ASC;
      `;
      params = [groupId, afterId, userId];
    } else {
      query = `
        SELECT * FROM mls_group_messages
        WHERE group_id = $1 AND id > $2
        ORDER BY id ASC;
      `;
      params = [groupId, afterId];
    }

    const { rows } = await db.query(query, params);
    return rows;
  },

  async getUserGroups(userId) {
    const query = `
      SELECT g.group_id, g.name, g.created_at, g.created_by
      FROM mls_groups g
      JOIN mls_group_members m ON g.group_id = m.group_id
      WHERE m.user_id = $1
      ORDER BY g.created_at DESC;
    `;
    const { rows } = await db.query(query, [userId]);
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
  },

  // Direct Message (DM) functions

  async findDirectMessage(userAId, userBId) {
    const [minId, maxId] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
    const query = `
      SELECT group_id FROM mls_direct_messages
      WHERE user_a_id = $1 AND user_b_id = $2;
    `;
    const { rows } = await db.query(query, [minId, maxId]);
    return rows[0]?.group_id || null;
  },

  async createDirectMessage(creatorId, targetId) {
    const [minId, maxId] = creatorId < targetId ? [creatorId, targetId] : [targetId, creatorId];
    const groupId = `dm_${minId}_${maxId}`;

    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');

      // Create group (no name for DMs)
      await client.query(
        'INSERT INTO mls_groups (group_id, name, created_by) VALUES ($1, $2, $3)',
        [groupId, null, creatorId]
      );

      // Create DM entry
      await client.query(
        'INSERT INTO mls_direct_messages (group_id, user_a_id, user_b_id, created_by) VALUES ($1, $2, $3, $4)',
        [groupId, minId, maxId, creatorId]
      );

      // Add both users as members
      await client.query(
        'INSERT INTO mls_group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)',
        [groupId, minId, maxId]
      );

      await client.query('COMMIT');
      return { groupId, isNew: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async getDirectMessages(userId) {
    const query = `
      SELECT dm.group_id, dm.created_at,
             CASE WHEN dm.user_a_id = $1 THEN dm.user_b_id ELSE dm.user_a_id END as other_user_id,
             u.username as other_username
      FROM mls_direct_messages dm
      JOIN users u ON u.id = CASE WHEN dm.user_a_id = $1 THEN dm.user_b_id ELSE dm.user_a_id END
      WHERE dm.user_a_id = $1 OR dm.user_b_id = $1
      ORDER BY dm.created_at DESC;
    `;
    const { rows } = await db.query(query, [userId]);
    return rows;
  },

  async isDirectMessage(groupId) {
    const query = `SELECT 1 FROM mls_direct_messages WHERE group_id = $1;`;
    const { rows } = await db.query(query, [groupId]);
    return rows.length > 0;
  }
};

module.exports = mlsService;
