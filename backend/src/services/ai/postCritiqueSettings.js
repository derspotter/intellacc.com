const db = require('../../db');
const { AiValidationError } = require('./aiSettingsService');

const DEFAULT_MODEL = 'anthropic/claude-opus-5.5';
const OPTIONS = [
  { id: DEFAULT_MODEL, label: 'Claude Opus 5.5 — deeper review' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna — faster, lower cost' },
  { id: 'off', label: 'Off' }
];
const getSettings = async (userId) => {
  const result = await db.query('SELECT model FROM user_post_critique_settings WHERE user_id=$1', [userId]);
  return { model: result.rows[0]?.model || DEFAULT_MODEL, options: OPTIONS };
};
const saveSettings = async (userId, model) => {
  if (!OPTIONS.some((option) => option.id === model)) throw new AiValidationError('Choose one of the available critique models');
  await db.query(`INSERT INTO user_post_critique_settings (user_id,model) VALUES ($1,$2)
    ON CONFLICT (user_id) DO UPDATE SET model=EXCLUDED.model,updated_at=NOW()`, [userId, model]);
  return getSettings(userId);
};
const forPost = async (postId) => {
  const result = await db.query(`SELECT s.model FROM posts p
    LEFT JOIN user_post_critique_settings s ON s.user_id=p.user_id
    WHERE p.id=$1 AND p.is_hidden=FALSE AND p.community_group_id IS NULL AND p.parent_id IS NULL`, [postId]);
  return result.rows.length ? result.rows[0].model || DEFAULT_MODEL : 'off';
};
module.exports = { DEFAULT_MODEL, OPTIONS, getSettings, saveSettings, forPost };
