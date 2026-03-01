const express = require('express');
const router = express.Router();
const db = require('../db');
const mlsService = require('../services/mlsService');
const authenticateJWT = require('../middleware/auth');

// Middleware to ensure user is authenticated
router.use(authenticateJWT);

// Upload Key Package (single)
router.post('/key-package', async (req, res) => {
  try {
    const { deviceId, packageData, hash, notBefore, notAfter, isLastResort } = req.body;
    const userId = req.user.id;
    const result = await mlsService.upsertKeyPackage(
      userId,
      deviceId,
      packageData,
      hash,
      notBefore,
      notAfter,
      !!isLastResort
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload key package' });
  }
});

// Upload Key Packages (bulk)
router.post('/key-packages', async (req, res) => {
  try {
    const { deviceId, keyPackages } = req.body;
    const userId = req.user.id;

    if (!Array.isArray(keyPackages) || keyPackages.length === 0) {
      return res.status(400).json({ error: 'keyPackages array required' });
    }
    if (keyPackages.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 key packages per request' });
    }

    const result = await mlsService.insertKeyPackages(userId, deviceId, keyPackages);
    res.json({ inserted: result.length, keyPackages: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload key packages' });
  }
});

// Get Key Package count (for monitoring pool size)
router.get('/key-packages/count', async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.query.deviceId || null;
    const counts = await mlsService.getKeyPackageCount(userId, deviceId);
    res.json(counts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get key package count' });
  }
});

// Fetch another user's Key Package(s) (for inviting them to groups)
router.get('/key-package/:userId', async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);
    const returnAll = req.query.all === 'true';
    const deviceId = req.query.deviceId;

    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    if (deviceId) {
        const keyPackage = await mlsService.getKeyPackage(targetUserId, deviceId);
        if (!keyPackage) return res.status(404).json({ error: 'Key package not found for device' });
        return res.json(keyPackage);
    }

    if (returnAll) {
        const keyPackages = await mlsService.getKeyPackages(targetUserId);
        return res.json(keyPackages);
    }

    const keyPackage = await mlsService.getKeyPackage(targetUserId);
    if (!keyPackage) {
      return res.status(404).json({ error: 'Key package not found for user' });
    }
    res.json(keyPackage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch key package' });
  }
});

// Get pending welcome messages for current user
router.get('/messages/welcome', async (req, res) => {
  try {
    const userId = req.user.id;
    const welcomes = await mlsService.getPendingWelcomes(userId);
    res.json(welcomes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch welcome messages' });
  }
});

// Relay Queue Routes
router.get('/queue/pending', async (req, res) => {
    try {
        const devicePublicId = req.headers['x-device-id'];
        let deviceIds = [];

        if (devicePublicId) {
            const deviceRes = await db.query('SELECT id FROM user_devices WHERE device_public_id = $1 AND user_id = $2', [devicePublicId, req.user.id]);
            if (deviceRes.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
            deviceIds = deviceRes.rows.map((row) => row.id);
        } else {
            const allDevicesRes = await db.query('SELECT id FROM user_devices WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
            if (allDevicesRes.rows.length === 0) return res.status(404).json({ error: 'No active devices found' });
            deviceIds = allDevicesRes.rows.map((row) => row.id);
        }

        const messages = await mlsService.getPendingMessages(deviceIds);
        res.json(messages);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch pending messages' });
    }
});

router.post('/queue/ack', async (req, res) => {
    try {
        const devicePublicId = req.headers['x-device-id'];
        const { messageIds } = req.body;
        let deviceIds = [];

        if (devicePublicId) {
            const deviceRes = await db.query('SELECT id FROM user_devices WHERE device_public_id = $1 AND user_id = $2', [devicePublicId, req.user.id]);
            if (deviceRes.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
            deviceIds = deviceRes.rows.map((row) => row.id);
        } else {
            const allDevicesRes = await db.query('SELECT id FROM user_devices WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
            if (allDevicesRes.rows.length === 0) return res.status(404).json({ error: 'No active devices found' });
            deviceIds = allDevicesRes.rows.map((row) => row.id);
        }

        await mlsService.ackMessages(deviceIds, messageIds);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to ack messages' });
    }
});

// Send Welcome Message
router.post('/messages/welcome', async (req, res) => {
  try {
    const { groupId, receiverId, data, groupInfo } = req.body;
    const devicePublicId = req.headers['x-device-id'];
    const senderId = req.user.id;

    console.log('[MLS Welcome] senderId:', senderId, 'devicePublicId:', devicePublicId, 'groupId:', groupId, 'receiverId:', receiverId);

    if (!devicePublicId) {
      console.log('[MLS Welcome] Missing x-device-id header');
      return res.status(400).json({ error: 'x-device-id header required' });
    }

    const deviceRes = await db.query('SELECT id FROM user_devices WHERE device_public_id = $1 AND user_id = $2', [devicePublicId, senderId]);
    console.log('[MLS Welcome] Device lookup result:', deviceRes.rows);

    if (deviceRes.rows.length === 0) {
      console.log('[MLS Welcome] Device not found for user');
      return res.status(404).json({ error: 'Sender device not registered' });
    }

    const result = await mlsService.storeWelcomeMessage(groupId, deviceRes.rows[0].id, senderId, receiverId, data, groupInfo);
    console.log('[MLS Welcome] Stored successfully:', result);
    res.json(result);
  } catch (err) {
    console.error('[MLS Welcome] Error:', err);
    res.status(500).json({ error: 'Failed to send welcome message' });
  }
});

// Send Group Message (Commit/Application)
router.post('/messages/group', async (req, res) => {
  try {
    const { groupId, messageType, data, excludeUserIds, epoch } = req.body;
    const devicePublicId = req.headers['x-device-id'];
    const senderId = req.user.id;

    const deviceRes = await db.query('SELECT id FROM user_devices WHERE device_public_id = $1 AND user_id = $2', [devicePublicId, senderId]);
    if (deviceRes.rows.length === 0) return res.status(404).json({ error: 'Sender device not registered' });

    const result = await mlsService.storeGroupMessage(
      groupId,
      deviceRes.rows[0].id,
      senderId,
      messageType || 'application',
      data,
      { excludeUserIds, epoch }
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    if (err.message === 'Commit already pending for epoch') {
      return res.status(409).json({ error: err.message });
    }
    if (err.message === 'Commit epoch required') {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to send group message' });
  }
});

// Get User's Groups
router.get('/groups', async (req, res) => {
  try {
    const userId = req.user.id;
    const groups = await mlsService.getUserGroups(userId);
    res.json(groups);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Create Group
router.post('/groups', async (req, res) => {
  try {
    const { groupId, name } = req.body;
    const userId = req.user.id;

    // groupId is expected to be a hex string generated by the client

    const result = await mlsService.createGroup(groupId, name, userId);
    res.json(result);
  } catch (err) {
    if (err.code === '23505') { // Unique violation
      return res.status(409).json({ error: 'Group ID already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Publish GroupInfo for external commits
router.post('/groups/:groupId/group-info', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { groupInfo, epoch, isPublic } = req.body;

    if (!groupInfo) {
      return res.status(400).json({ error: 'groupInfo required' });
    }

    let groupInfoData = groupInfo;
    if (Array.isArray(groupInfo)) {
      groupInfoData = Buffer.from(groupInfo);
    }

    const result = await mlsService.publishGroupInfo(
      groupId,
      req.user.id,
      groupInfoData,
      epoch,
      isPublic
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    if (err.message === 'Sender is not a member of the group') {
      return res.status(403).json({ error: err.message });
    }
    if (err.message === 'Group not found') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to publish group info' });
  }
});

router.get('/groups/:groupId/group-info', async (req, res) => {
  try {
    const { groupId } = req.params;
    const result = await mlsService.getGroupInfo(groupId, req.user.id);
    res.json({
      groupInfo: result.group_info,
      epoch: result.group_info_epoch,
      isPublic: result.is_public
    });
  } catch (err) {
    console.error(err);
    if (err.message === 'Group not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message === 'Group info not accessible') {
      return res.status(403).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to fetch group info' });
  }
});

// Add Member to Group
router.post('/groups/:groupId/members', async (req, res) => {
  try {
    const { userId } = req.body;
    const { groupId } = req.params;
    // In a real implementation, we should verify the requester is already a member of the group
    // For now, we trust the client who has the groupId

    const result = await mlsService.addGroupMember(groupId, userId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add member to group' });
  }
});

// Sync Group Members from MLS state
router.post('/groups/:groupId/members/sync', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { memberIds } = req.body;

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'memberIds array required' });
    }

    const normalizedIds = memberIds
      .map(id => Number(id))
      .filter(Number.isFinite);

    if (normalizedIds.length === 0) {
      return res.status(400).json({ error: 'memberIds must be numeric' });
    }

    if (!normalizedIds.includes(req.user.id)) {
      return res.status(403).json({ error: 'User not in member list' });
    }

    const result = await mlsService.syncGroupMembers(groupId, normalizedIds);
    res.json(result);
  } catch (err) {
    console.error(err);
    if (err.message === 'Group not found') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to sync group members' });
  }
});

// Get Group Messages from relay queue
router.get('/messages/group/:groupId', async (req, res) => {
  try {
    const { afterId } = req.query;
    const messages = await mlsService.getGroupMessages(req.params.groupId, afterId || 0);
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch group messages' });
  }
});

// ============ Direct Messages (DM) Routes ============

// List user's DMs
router.get('/direct-messages', async (req, res) => {
  try {
    const dms = await mlsService.getDirectMessages(req.user.id);
    res.json(dms);
  } catch (err) {
    console.error('Error fetching DMs:', err);
    res.status(500).json({ error: 'Failed to fetch direct messages' });
  }
});

// Get or create DM with a user
router.post('/direct-messages/:targetUserId', async (req, res) => {
  try {
    const creatorId = req.user.id;
    const targetId = parseInt(req.params.targetUserId);

    if (isNaN(targetId)) {
      return res.status(400).json({ error: 'Invalid target user ID' });
    }

    if (creatorId === targetId) {
      return res.status(400).json({ error: 'Cannot create DM with yourself' });
    }

    // Check if DM already exists
    const existingGroupId = await mlsService.findDirectMessage(creatorId, targetId);

    if (existingGroupId) {
      return res.json({ groupId: existingGroupId, isNew: false });
    }

    // Create new DM
    const result = await mlsService.createDirectMessage(creatorId, targetId);
    res.status(201).json(result);
  } catch (err) {
    console.error('Error creating DM:', err);
    res.status(500).json({ error: 'Failed to create direct message' });
  }
});

// Rehydrate welcomes for an existing DM when the client is missing local group state.
router.post('/direct-messages/:targetUserId/rehydrate', async (req, res) => {
  try {
    const requesterId = req.user.id;
    const targetId = parseInt(req.params.targetUserId);

    if (isNaN(targetId)) {
      return res.status(400).json({ error: 'Invalid target user ID' });
    }

    if (requesterId === targetId) {
      return res.status(400).json({ error: 'Cannot rehydrate DM with yourself' });
    }

    const groupId = await mlsService.findDirectMessage(requesterId, targetId);
    if (!groupId) {
      return res.status(404).json({ error: 'Direct message not found' });
    }

    const result = await mlsService.rehydrateDirectMessageWelcomes(requesterId, targetId, groupId);
    res.json(result);
  } catch (err) {
    console.error('Error rehydrating direct message welcomes:', err);
    if (err.message === 'Requester is not part of this direct message'
      || err.message === 'Target user is not part of this direct message') {
      return res.status(403).json({ error: err.message });
    }
    if (err.message === 'Direct message not found') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to rehydrate direct message' });
  }
});

module.exports = router;
