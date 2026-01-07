const db = require('../db');
const pushNotificationService = require('./pushNotificationService');

let io = null;

const mlsService = {
  setSocketIo(socketIo) {
    io = socketIo;
    console.log('[MLS] Socket.IO instance set');
  },

  // Ensure device exists in user_devices table (required for message routing)
  async ensureDeviceRegistered(userId, deviceId) {
    const query = `
      INSERT INTO user_devices (user_id, device_public_id, name, is_primary)
      VALUES ($1, $2, 'MLS Device', false)
      ON CONFLICT (device_public_id) DO UPDATE SET last_seen_at = NOW()
      RETURNING *;
    `;
    const { rows } = await db.query(query, [userId, deviceId]);
    return rows[0];
  },

  async upsertKeyPackage(userId, deviceId, packageData, hash, notBefore, notAfter, isLastResort = false) {
    // Ensure device is registered before uploading key package
    await this.ensureDeviceRegistered(userId, deviceId);
    if (isLastResort) {
      // Last-resort: UPSERT - only one per (user_id, device_id)
      const query = `
        INSERT INTO mls_key_packages (user_id, device_id, package_data, hash, not_before, not_after, is_last_resort, last_updated_at)
        VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), true, NOW())
        ON CONFLICT (user_id, device_id) WHERE is_last_resort = true
        DO UPDATE SET package_data = $3, hash = $4, not_before = to_timestamp($5), not_after = to_timestamp($6), last_updated_at = NOW()
        RETURNING *;
      `;
      const { rows } = await db.query(query, [userId, deviceId, packageData, hash, notBefore, notAfter]);
      return rows[0];
    } else {
      // Regular: INSERT with ON CONFLICT DO NOTHING (ignore duplicates by hash)
      const query = `
        INSERT INTO mls_key_packages (user_id, device_id, package_data, hash, not_before, not_after, is_last_resort, last_updated_at)
        VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), false, NOW())
        ON CONFLICT (hash) DO NOTHING
        RETURNING *;
      `;
      const { rows } = await db.query(query, [userId, deviceId, packageData, hash, notBefore, notAfter]);
      return rows[0];
    }
  },

  // Bulk insert multiple key packages
  async insertKeyPackages(userId, deviceId, keyPackages) {
    // Ensure device is registered before uploading key packages
    await this.ensureDeviceRegistered(userId, deviceId);

    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const kp of keyPackages) {
        const query = `
          INSERT INTO mls_key_packages (user_id, device_id, package_data, hash, not_before, not_after, is_last_resort, last_updated_at)
          VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), $7, NOW())
          ON CONFLICT (hash) DO NOTHING
          RETURNING *;
        `;
        const { rows } = await client.query(query, [
          userId, deviceId, kp.packageData, kp.hash, kp.notBefore, kp.notAfter, kp.isLastResort || false
        ]);
        if (rows[0]) results.push(rows[0]);
      }
      await client.query('COMMIT');
      return results;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  // Get and optionally consume a key package
  // consume=true will delete non-last-resort key packages after fetching
  async getKeyPackage(userId, deviceId = null, consume = true) {
    const params = [userId];
    let deviceClause = '';
    if (deviceId) {
      params.push(deviceId);
      deviceClause = 'AND device_id = $2';
    }
    const query = `
      SELECT *
      FROM mls_key_packages
      WHERE user_id = $1
        ${deviceClause}
        AND (not_before IS NULL OR not_before <= NOW())
        AND (not_after IS NULL OR not_after > NOW())
      ORDER BY is_last_resort ASC, last_updated_at DESC
      LIMIT 1;
    `;
    const { rows } = await db.query(query, params);
    const keyPackage = rows[0];

    // Consume (delete) non-last-resort key packages after fetching
    if (consume && keyPackage && !keyPackage.is_last_resort) {
      await db.query('DELETE FROM mls_key_packages WHERE id = $1', [keyPackage.id]);
    }

    return keyPackage;
  },

  // Get key package count for a user/device (for monitoring pool size)
  async getKeyPackageCount(userId, deviceId = null) {
    const params = [userId];
    let deviceClause = '';
    if (deviceId) {
      params.push(deviceId);
      deviceClause = 'AND device_id = $2';
    }
    const query = `
      SELECT
        COUNT(*) FILTER (WHERE is_last_resort = false) as regular_count,
        COUNT(*) FILTER (WHERE is_last_resort = true) as last_resort_count
      FROM mls_key_packages
      WHERE user_id = $1
        ${deviceClause}
        AND (not_before IS NULL OR not_before <= NOW())
        AND (not_after IS NULL OR not_after > NOW());
    `;
    const { rows } = await db.query(query, params);
    return {
      regular: parseInt(rows[0]?.regular_count || 0, 10),
      lastResort: parseInt(rows[0]?.last_resort_count || 0, 10)
    };
  },

  async getKeyPackages(userId) {
    const query = `
      SELECT DISTINCT ON (device_id) *
      FROM mls_key_packages
      WHERE user_id = $1
        AND (not_before IS NULL OR not_before <= NOW())
        AND (not_after IS NULL OR not_after > NOW())
      ORDER BY device_id, is_last_resort ASC, last_updated_at DESC;
    `;
    const { rows } = await db.query(query, [userId]);
    return rows;
  },

  async isGroupMember(groupId, userId) {
    const query = `
      SELECT 1 FROM mls_group_members WHERE group_id = $1 AND user_id = $2;
    `;
    const { rows } = await db.query(query, [groupId, userId]);
    return rows.length > 0;
  },

  async storeWelcomeMessage(groupId, senderDeviceId, senderUserId, receiverUserId, data, groupInfo = null) {
    const isMember = await this.isGroupMember(groupId, senderUserId);
    if (!isMember) {
        throw new Error('Sender is not a member of the group');
    }

    const client = await db.getPool().connect();
    try {
        await client.query('BEGIN');
        
        const { rows: [queueRow] } = await client.query(
            'INSERT INTO mls_relay_queue (group_id, sender_device_id, message_type, data, group_info) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [groupId, senderDeviceId, 'welcome', data, groupInfo]
        );
        const queueId = queueRow.id;

        const devicesRes = await client.query(
            'SELECT id FROM user_devices WHERE user_id = $1 AND revoked_at IS NULL',
            [receiverUserId]
        );
        
        for (const device of devicesRes.rows) {
            await client.query(
                'INSERT INTO mls_relay_recipients (queue_id, recipient_device_id) VALUES ($1, $2)',
                [queueId, device.id]
            );
        }

        await client.query('COMMIT');
        if (io) io.to(`mls:${receiverUserId}`).emit('mls-welcome', { groupId });
        return { queueId };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
  },

  async storeGroupMessage(groupId, senderDeviceId, senderUserId, messageType, data, options = {}) {
    console.log(`[MLS Store] groupId=${groupId} senderDevice=${senderDeviceId} senderUser=${senderUserId} type=${messageType}`);

    const isMember = await this.isGroupMember(groupId, senderUserId);
    if (!isMember) {
        console.log(`[MLS Store] Sender ${senderUserId} is NOT a member of ${groupId}`);
        throw new Error('Sender is not a member of the group');
    }

    const client = await db.getPool().connect();
    try {
        await client.query('BEGIN');

        const parsedEpoch = Number(options.epoch);
        const epoch = Number.isSafeInteger(parsedEpoch) ? parsedEpoch : null;
        if (messageType === 'commit') {
            if (epoch === null) {
                throw new Error('Commit epoch required');
            }
            const conflict = await client.query(
                'SELECT 1 FROM mls_relay_queue WHERE group_id = $1 AND message_type = $2 AND epoch = $3 LIMIT 1',
                [groupId, 'commit', epoch]
            );
            if (conflict.rows.length > 0) {
                throw new Error('Commit already pending for epoch');
            }
        }
        
        let queueRow;
        try {
            const result = await client.query(
                'INSERT INTO mls_relay_queue (group_id, sender_device_id, message_type, data, epoch) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [groupId, senderDeviceId, messageType, data, epoch]
            );
            queueRow = result.rows[0];
        } catch (err) {
            if (messageType === 'commit' && err.code === '23505') {
                throw new Error('Commit already pending for epoch');
            }
            throw err;
        }
        const queueId = queueRow.id;

        // OpenMLS Book: commit fanout is for existing members only; new members receive Welcome.
        const excludeUserIds = Array.isArray(options.excludeUserIds)
            ? options.excludeUserIds.map(Number).filter(Number.isFinite)
            : [];

        let deviceQuery = `
            SELECT ud.id, ud.user_id FROM user_devices ud
            JOIN mls_group_members gm ON ud.user_id = gm.user_id
            WHERE gm.group_id = $1 AND ud.id != $2 AND ud.revoked_at IS NULL
        `;
        const deviceParams = [groupId, senderDeviceId];

        if (excludeUserIds.length > 0) {
            deviceQuery += ' AND NOT (ud.user_id = ANY($3))';
            deviceParams.push(excludeUserIds);
        }

        const devicesRes = await client.query(deviceQuery, deviceParams);
        console.log(`[MLS Store] Found ${devicesRes.rows.length} recipient devices for queueId=${queueId}:`, devicesRes.rows);

        const notifiedUsers = new Set();
        for (const device of devicesRes.rows) {
            await client.query(
                'INSERT INTO mls_relay_recipients (queue_id, recipient_device_id) VALUES ($1, $2)',
                [queueId, device.id]
            );
            notifiedUsers.add(device.user_id);
        }

        await client.query('COMMIT');
        console.log(`[MLS Store] COMMITTED queueId=${queueId} with ${devicesRes.rows.length} recipients`);
        if (io) {
            for (const uid of notifiedUsers) {
                io.to(`mls:${uid}`).emit('mls-message', { groupId });
            }
        }

        // Send push notifications for application messages (actual user messages)
        if (messageType === 'application') {
            // Get sender username for push notification
            const senderRes = await db.query('SELECT username FROM users WHERE id = $1', [senderUserId]);
            const senderUsername = senderRes.rows[0]?.username || 'Someone';

            for (const uid of notifiedUsers) {
                if (uid !== senderUserId) {
                    pushNotificationService.sendMessagePush(uid, senderUsername)
                        .catch(err => console.error('[Push] Error sending message push:', err));
                }
            }
        }

        return { queueId };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
  },

  async getPendingMessages(deviceId) {
    // Return welcome messages immediately, but hold back application/commit messages
    // until the welcome for that group has been acked by this device
    const query = `
      SELECT q.id, q.group_id, q.sender_device_id, q.message_type, q.data, q.group_info, q.created_at,
             sender_ud.user_id AS sender_user_id
      FROM mls_relay_queue q
      JOIN mls_relay_recipients r ON q.id = r.queue_id
      JOIN user_devices sender_ud ON q.sender_device_id = sender_ud.id
      WHERE r.recipient_device_id = $1 AND r.acked_at IS NULL
        AND (
          -- Always return welcome messages
          q.message_type = 'welcome'
          OR
          -- For non-welcome messages, only return if no pending welcome for this group
          NOT EXISTS (
            SELECT 1 FROM mls_relay_queue w
            JOIN mls_relay_recipients wr ON w.id = wr.queue_id
            WHERE w.group_id = q.group_id
              AND w.message_type = 'welcome'
              AND wr.recipient_device_id = $1
              AND wr.acked_at IS NULL
          )
        )
      ORDER BY q.created_at ASC;
    `;
    const { rows } = await db.query(query, [deviceId]);
    return rows;
  },

  async ackMessages(deviceId, messageIds) {
    console.log(`[MLS Ack] deviceId=${deviceId} messageIds=${JSON.stringify(messageIds)}`);
    if (!messageIds || messageIds.length === 0) return;
    const client = await db.getPool().connect();
    try {
        await client.query('BEGIN');

        // Check if any of the acked messages are welcomes - we'll need to notify about held-back messages
        const welcomeRes = await client.query(
            'SELECT q.group_id, ud.user_id FROM mls_relay_queue q JOIN user_devices ud ON ud.id = $1 WHERE q.id = ANY($2) AND q.message_type = \'welcome\'',
            [deviceId, messageIds]
        );
        const ackedWelcomes = welcomeRes.rows;

        // Check what recipients exist before update
        const beforeRes = await client.query(
            'SELECT queue_id, recipient_device_id, acked_at FROM mls_relay_recipients WHERE queue_id = ANY($1)',
            [messageIds]
        );
        console.log(`[MLS Ack] Recipients before update:`, beforeRes.rows);

        await client.query(
            'UPDATE mls_relay_recipients SET acked_at = NOW() WHERE recipient_device_id = $1 AND queue_id = ANY($2)',
            [deviceId, messageIds]
        );

        // Check what will be deleted
        const toDeleteRes = await client.query(`
            SELECT id FROM mls_relay_queue WHERE id = ANY($1) AND id NOT IN (
                SELECT queue_id FROM mls_relay_recipients WHERE queue_id = ANY($1) AND acked_at IS NULL
            )
        `, [messageIds]);
        console.log(`[MLS Ack] Will delete queue IDs:`, toDeleteRes.rows.map(r => r.id));

        await client.query(`
            DELETE FROM mls_relay_queue WHERE id = ANY($1) AND id NOT IN (
                SELECT queue_id FROM mls_relay_recipients WHERE queue_id = ANY($1) AND acked_at IS NULL
            )
        `, [messageIds]);

        // Add user as member of the group when they ack a welcome (they've now accepted the invite)
        for (const welcome of ackedWelcomes) {
            console.log(`[MLS Ack] Welcome acked for group ${welcome.group_id}, adding user ${welcome.user_id} as member`);
            await client.query(
                'INSERT INTO mls_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT (group_id, user_id) DO NOTHING',
                [welcome.group_id, welcome.user_id]
            );

            // Add this device as recipient to any queued application messages for this group
            // (messages sent while user wasn't a member yet)
            // NOTE: Only application messages - commits are for existing members, new members join via welcome
            const queuedMsgsRes = await client.query(
                `SELECT q.id FROM mls_relay_queue q
                 WHERE q.group_id = $1 AND q.message_type = 'application'
                   AND NOT EXISTS (SELECT 1 FROM mls_relay_recipients r WHERE r.queue_id = q.id AND r.recipient_device_id = $2)`,
                [welcome.group_id, deviceId]
            );
            for (const msg of queuedMsgsRes.rows) {
                await client.query(
                    'INSERT INTO mls_relay_recipients (queue_id, recipient_device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [msg.id, deviceId]
                );
            }
            if (queuedMsgsRes.rows.length > 0) {
                console.log(`[MLS Ack] Added ${queuedMsgsRes.rows.length} held-back messages as recipient for device ${deviceId}`);
            }
        }

        await client.query('COMMIT');

        // After commit: notify clients about held-back messages that are now available
        if (io && ackedWelcomes.length > 0) {
            for (const welcome of ackedWelcomes) {
                io.to(`mls:${welcome.user_id}`).emit('mls-message', { groupId: welcome.group_id });
            }
        }
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
  },

  async cleanupExpired() {
    await db.query('DELETE FROM mls_relay_queue WHERE expires_at < NOW()');
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

  async publishGroupInfo(groupId, userId, groupInfo, epoch, isPublic) {
    const isMember = await this.isGroupMember(groupId, userId);
    if (!isMember) {
        throw new Error('Sender is not a member of the group');
    }

    const query = `
      UPDATE mls_groups
      SET group_info = $1,
          group_info_epoch = $2,
          group_info_updated_at = NOW(),
          is_public = $3,
          updated_at = NOW()
      WHERE group_id = $4
      RETURNING group_id, is_public, group_info_epoch, group_info_updated_at;
    `;

    const { rows } = await db.query(query, [groupInfo, epoch ?? null, !!isPublic, groupId]);
    if (rows.length === 0) {
      throw new Error('Group not found');
    }
    return rows[0];
  },

  async getGroupInfo(groupId, userId) {
    const query = `
      SELECT group_info, group_info_epoch, is_public
      FROM mls_groups
      WHERE group_id = $1;
    `;
    const { rows } = await db.query(query, [groupId]);
    if (rows.length === 0) {
      throw new Error('Group not found');
    }
    const row = rows[0];
    if (!row.is_public) {
      const isMember = await this.isGroupMember(groupId, userId);
      if (!isMember) {
        throw new Error('Group info not accessible');
      }
    }
    return row;
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

  async syncGroupMembers(groupId, memberIds) {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');

      const groupRes = await client.query('SELECT 1 FROM mls_groups WHERE group_id = $1', [groupId]);
      if (groupRes.rows.length === 0) {
        throw new Error('Group not found');
      }

      await client.query('DELETE FROM mls_group_members WHERE group_id = $1', [groupId]);

      for (const memberId of memberIds) {
        await client.query(
          'INSERT INTO mls_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [groupId, memberId]
        );
      }

      await client.query('COMMIT');
      return { groupId, memberCount: memberIds.length };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
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

      // Only add creator as member - invitee is added when they ack the welcome
      await client.query(
        'INSERT INTO mls_group_members (group_id, user_id) VALUES ($1, $2)',
        [groupId, creatorId]
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
    // Only return DMs where the user has joined (is in mls_group_members)
    // This excludes DMs where user was invited but hasn't accepted the welcome yet
    const query = `
      SELECT dm.group_id, dm.created_at,
             CASE WHEN dm.user_a_id = $1 THEN dm.user_b_id ELSE dm.user_a_id END as other_user_id,
             u.username as other_username
      FROM mls_direct_messages dm
      JOIN users u ON u.id = CASE WHEN dm.user_a_id = $1 THEN dm.user_b_id ELSE dm.user_a_id END
      JOIN mls_group_members gm ON gm.group_id = dm.group_id AND gm.user_id = $1
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
  },

  async getPendingWelcomes(userId) {
    // Get all pending welcome messages for this user's devices
    const query = `
      SELECT q.id, q.group_id, q.sender_device_id, q.data, q.group_info, q.created_at
      FROM mls_relay_queue q
      JOIN mls_relay_recipients r ON q.id = r.queue_id
      JOIN user_devices ud ON r.recipient_device_id = ud.id
      WHERE ud.user_id = $1 AND q.message_type = 'welcome' AND r.acked_at IS NULL
      ORDER BY q.created_at ASC;
    `;
    const { rows } = await db.query(query, [userId]);
    return rows;
  },

  async getGroupMessages(groupId, afterId = 0) {
    // Get application messages for a group from relay queue
    const query = `
      SELECT q.id, q.group_id, q.sender_device_id, q.message_type, q.data, q.created_at, ud.user_id as sender_user_id
      FROM mls_relay_queue q
      JOIN user_devices ud ON q.sender_device_id = ud.id
      WHERE q.group_id = $1 AND q.message_type = 'application' AND q.id > $2
      ORDER BY q.created_at ASC LIMIT 100;
    `;
    const { rows } = await db.query(query, [groupId, afterId]);
    return rows;
  }
};

module.exports = mlsService;
