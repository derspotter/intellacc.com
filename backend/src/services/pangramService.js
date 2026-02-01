/**
 * Pangram AI Detection Service
 * Analyzes content and stores AI detection results
 */
const axios = require('axios');
const db = require('../db');

const PANGRAM_API_KEY = process.env.PANGRAM_API_KEY;
const PANGRAM_API_URL = process.env.PANGRAM_API_URL || 'https://api.pangram.com/v1/detect';
const AI_FLAG_THRESHOLD = parseFloat(process.env.AI_FLAG_THRESHOLD || '0.85');
const MIN_CONTENT_LENGTH = parseInt(process.env.AI_MIN_CONTENT_LENGTH || '50', 10);

exports.analyzeContent = async ({ text, contentType, contentId, userId }) => {
  if (!text || text.length < MIN_CONTENT_LENGTH) {
    return { ai_probability: 0, detected_model: null, is_flagged: false, skipped: true };
  }

  if (!PANGRAM_API_KEY) {
    console.warn('[Pangram] Missing API key. Skipping analysis.');
    return { ai_probability: 0, detected_model: null, is_flagged: false, skipped: true };
  }

  const response = await axios.post(
    PANGRAM_API_URL,
    { text },
    {
      headers: {
        Authorization: `Bearer ${PANGRAM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );

  const result = response.data || {};
  const aiProbability = Number(result.ai_probability || 0);
  const detectedModel = result.detected_model || null;
  const isFlagged = aiProbability >= AI_FLAG_THRESHOLD;

  const existing = await db.query(`
    SELECT is_flagged
    FROM content_ai_analysis
    WHERE content_type = $1 AND content_id = $2
    ORDER BY analyzed_at DESC
    LIMIT 1
  `, [contentType, contentId]);

  const wasFlagged = existing.rows[0]?.is_flagged === true;

  await db.query(`
    DELETE FROM content_ai_analysis
    WHERE content_type = $1 AND content_id = $2
  `, [contentType, contentId]);

  await db.query(`
    INSERT INTO content_ai_analysis (content_type, content_id, user_id, ai_probability, detected_model, is_flagged)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [contentType, contentId, userId, aiProbability, detectedModel, isFlagged]);

  if (isFlagged && !wasFlagged) {
    await db.query(`
      UPDATE users SET ai_flag_count = ai_flag_count + 1 WHERE id = $1
    `, [userId]);
  } else if (!isFlagged && wasFlagged) {
    await db.query(`
      UPDATE users SET ai_flag_count = GREATEST(ai_flag_count - 1, 0) WHERE id = $1
    `, [userId]);
  }

  return { ai_probability: aiProbability, detected_model: detectedModel, is_flagged: isFlagged };
};
