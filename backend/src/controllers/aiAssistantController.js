// HTTP layer for the personal BYOK AI assistant (JWT sessions only; the
// router rejects agent keys before reaching here).
const settingsService = require('../services/ai/aiSettingsService');
const conversationService = require('../services/ai/aiConversationService');
const publicReplyService = require('../services/ai/aiPublicReplyService');

const { AiValidationError } = settingsService;
const { AiRequestError, AiBudgetError } = conversationService;

const sendError = (res, error, fallback) => {
  if (error instanceof AiValidationError) return res.status(error.status).json({ error: 'validation', message: error.message });
  if (error instanceof AiRequestError) {
    const body = { error: error.code, message: error.message };
    if (error.errorCode) body.errorCode = error.errorCode;
    return res.status(error.status).json(body);
  }
  if (error instanceof AiBudgetError) return res.status(429).json({ error: error.code, message: error.message });
  console.error(`[AI] ${fallback}:`, error?.message || error);
  return res.status(500).json({ error: 'internal', message: fallback });
};

exports.getSettings = async (req, res) => {
  try {
    res.json(await settingsService.getSettings(req.user.id));
  } catch (error) {
    sendError(res, error, 'Failed to load AI settings');
  }
};

exports.saveSettings = async (req, res) => {
  try {
    const { provider, model, apiKey, publicReplies } = req.body || {};
    res.json(await settingsService.saveSettings(req.user.id, { provider, model, apiKey, publicReplies }));
  } catch (error) {
    sendError(res, error, 'Failed to save AI settings');
  }
};

exports.deleteSettings = async (req, res) => {
  try {
    await settingsService.deleteSettings(req.user.id);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error, 'Failed to delete AI settings');
  }
};

exports.testSettings = async (req, res) => {
  try {
    res.json(await conversationService.testSettings(req.user.id));
  } catch (error) {
    sendError(res, error, 'AI connection test failed');
  }
};

exports.listConversations = async (req, res) => {
  try {
    res.json({ conversations: await conversationService.listConversations(req.user.id) });
  } catch (error) {
    sendError(res, error, 'Failed to list conversations');
  }
};

exports.createConversation = async (req, res) => {
  try {
    const conversation = await conversationService.createConversation(req.user.id, { postId: req.body?.postId });
    res.status(201).json({ conversation });
  } catch (error) {
    sendError(res, error, 'Failed to create conversation');
  }
};

exports.getConversation = async (req, res) => {
  try {
    const result = await conversationService.getConversation(req.user.id, req.params.id);
    if (!result) return res.status(404).json({ error: 'not_found', message: 'Conversation not found' });
    res.json(result);
  } catch (error) {
    sendError(res, error, 'Failed to load conversation');
  }
};

exports.deleteConversation = async (req, res) => {
  try {
    const outcome = await conversationService.deleteConversation(req.user.id, req.params.id);
    if (outcome === 'not_found') return res.status(404).json({ error: 'not_found', message: 'Conversation not found' });
    if (outcome === 'busy') return res.status(409).json({ error: 'busy', message: 'Wait for the current answer before deleting' });
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error, 'Failed to delete conversation');
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { message, requestId } = req.body || {};
    res.json(await conversationService.sendMessage(req.user.id, req.params.id, { message, requestId }));
  } catch (error) {
    sendError(res, error, 'The assistant could not answer');
  }
};

exports.getPublicReplyStatus = async (req, res) => {
  try {
    const postId = Number(req.params.postId);
    if (!/^[1-9]\d*$/.test(req.params.postId) || !Number.isSafeInteger(postId) || postId > 2147483647) return res.status(400).json({ error: 'bad_request', message: 'Invalid post id' });
    const status = await publicReplyService.getStatus(req.user.id, postId);
    if (!status) return res.status(404).json({ error: 'not_found', message: 'No AI reply request for this post' });
    res.json(status);
  } catch (error) {
    sendError(res, error, 'Failed to load AI reply status');
  }
};
