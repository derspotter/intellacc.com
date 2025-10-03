// backend/src/controllers/e2eeController.js
const e2eeService = require('../services/e2eeService');

function requireString(val) {
  return typeof val === 'string' && val.length > 0;
}

async function publishIdentity(req, res) {
  try {
    const userId = req.user.id;
    const { deviceId = 'default', identityKey, signingKey } = req.body || {};
    if (!requireString(identityKey) || !requireString(signingKey)) {
      return res.status(400).json({ error: 'identityKey and signingKey are required' });
    }
    await e2eeService.publishIdentity(userId, identityKey, signingKey, deviceId);
    res.json({ success: true });
  } catch (err) {
    console.error('publishIdentity error:', err);
    res.status(500).json({ error: 'Failed to publish identity keys' });
  }
}

async function publishPrekeys(req, res) {
  try {
    const userId = req.user.id;
    const { deviceId = 'default', signedPreKey, oneTimePreKeys } = req.body || {};
    if (!signedPreKey && !Array.isArray(oneTimePreKeys)) {
      return res.status(400).json({ error: 'signedPreKey or oneTimePreKeys required' });
    }
    await e2eeService.publishPrekeys(userId, signedPreKey, oneTimePreKeys, deviceId);
    res.json({ success: true });
  } catch (err) {
    console.error('publishPrekeys error:', err);
    res.status(500).json({ error: 'Failed to publish prekeys' });
  }
}

async function getBundle(req, res) {
  try {
    const { userId: targetUserId, deviceId = 'default' } = req.query || {};
    const id = parseInt(targetUserId);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'userId is required' });
    }
    const bundle = await e2eeService.getKeyBundle(id, deviceId);
    if (!bundle) {
      return res.status(404).json({ error: 'No key bundle found' });
    }
    res.json(bundle);
  } catch (err) {
    console.error('getBundle error:', err);
    res.status(500).json({ error: 'Failed to fetch key bundle' });
  }
}

module.exports = {
  publishIdentity,
  publishPrekeys,
  getBundle,
  consumePrekey,
};

async function consumePrekey(req, res) {
  try {
    const userId = req.user.id;
    const { deviceId = 'default', keyId } = req.body || {};
    if (keyId == null || isNaN(parseInt(keyId))) {
      return res.status(400).json({ error: 'keyId is required' });
    }
    const count = await e2eeService.markPrekeyUsed(userId, deviceId, parseInt(keyId));
    if (count === 0) return res.status(404).json({ error: 'Prekey not found or already used' });
    res.json({ success: true, used: count });
  } catch (err) {
    console.error('consumePrekey error:', err);
    res.status(500).json({ error: 'Failed to consume prekey' });
  }
}
