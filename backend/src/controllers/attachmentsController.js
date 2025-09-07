// backend/src/controllers/attachmentsController.js
// Minimal scaffold for pre-signed upload/download endpoints

/**
 * Issue a pre-signed upload URL for object storage
 * Body: { fileName, contentType, contentLength }
 */
async function presignUpload(req, res) {
  try {
    const { fileName, contentType, contentLength } = req.body || {};
    if (!fileName || !contentType || !contentLength) {
      return res.status(400).json({ error: 'fileName, contentType, and contentLength are required' });
    }
    // Basic validation
    const MAX_BYTES = 10 * 1024 * 1024; // 10MB
    if (contentLength > MAX_BYTES) {
      return res.status(400).json({ error: 'File too large' });
    }
    // TODO: integrate with S3/GCS/Azure to generate a pre-signed PUT URL
    // For now return a placeholder to implement later
    return res.json({
      uploadUrl: null,
      objectKey: null,
      expiresIn: 900
    });
  } catch (error) {
    console.error('presignUpload error:', error);
    res.status(500).json({ error: 'Failed to prepare upload' });
  }
}

/**
 * Issue a pre-signed download URL for object storage
 * Query: ?objectKey=...
 */
async function presignDownload(req, res) {
  try {
    const { objectKey } = req.query || {};
    if (!objectKey) {
      return res.status(400).json({ error: 'objectKey required' });
    }
    // TODO: integrate with S3/GCS/Azure to generate a pre-signed GET URL
    return res.json({
      downloadUrl: null,
      expiresIn: 900
    });
  } catch (error) {
    console.error('presignDownload error:', error);
    res.status(500).json({ error: 'Failed to prepare download' });
  }
}

module.exports = {
  presignUpload,
  presignDownload
};


