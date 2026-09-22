const db = require('../../db');
const { AiValidationError, getSettings: getAiSettings } = require('./aiSettingsService');
const { isValidModel } = require('./providers');

const getSettings = async (userId) => {
  const result = await db.query('SELECT model,enabled FROM user_post_critique_settings WHERE user_id=$1', [userId]);
  const ai = await getAiSettings(userId);
  const row = result.rows[0];
  return { enabled: Boolean(row?.enabled), model: row?.model === 'off' ? '' : row?.model || '',
    effectiveModel: row?.model && row.model !== 'off' ? row.model : ai.model,
    configured: ai.configured && ai.available, provider: ai.provider };
};
const saveSettings = async (userId, { model = '', enabled } = {}) => {
  if (typeof enabled !== 'boolean') throw new AiValidationError('enabled must be true or false');
  if (typeof model !== 'string' || (model.trim() && !isValidModel(model.trim()))) throw new AiValidationError('Enter a valid provider model ID');
  const ai = await getAiSettings(userId);
  if (enabled && (!ai.configured || !ai.available || !isValidModel(model.trim() || ai.model))) {
    throw new AiValidationError('Save your own provider, API key and model in Your AI assistant first');
  }
  await db.query(`INSERT INTO user_post_critique_settings (user_id,model,enabled) VALUES ($1,$2,$3)
    ON CONFLICT (user_id) DO UPDATE SET model=EXCLUDED.model,enabled=EXCLUDED.enabled,updated_at=NOW()`,
  [userId, model.trim(), enabled]);
  return getSettings(userId);
};
const forPost = async (postId, client = db) => {
  const result = await client.query(`SELECT p.user_id,COALESCE(NULLIF(s.model,''),a.model) AS model
    FROM posts p JOIN user_post_critique_settings s ON s.user_id=p.user_id AND s.enabled=TRUE
    JOIN user_ai_settings a ON a.user_id=p.user_id AND a.key_ciphertext IS NOT NULL
    WHERE p.id=$1 AND p.is_hidden=FALSE AND p.community_group_id IS NULL AND p.parent_id IS NULL`, [postId]);
  return result.rows[0] || null;
};
module.exports = { getSettings, saveSettings, forPost };
