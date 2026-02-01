// backend/src/controllers/attachmentsController.js
// Local uploads with JWT-gated download endpoints

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');

const MAX_BYTES_POST = parseInt(process.env.ATTACHMENTS_MAX_BYTES_POST || '', 10) || 10 * 1024 * 1024; // 10MB
const MAX_BYTES_MESSAGE = parseInt(process.env.ATTACHMENTS_MAX_BYTES_MESSAGE || '', 10) || 25 * 1024 * 1024; // 25MB
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
const POSTS_DIR = path.join(UPLOADS_DIR, 'posts');
const MESSAGES_DIR = path.join(UPLOADS_DIR, 'messages');
const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif'
]);
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif'
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildStorage(subdir) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const target = path.join(UPLOADS_DIR, subdir);
      ensureDir(target);
      cb(null, target);
    },
    filename: (req, file, cb) => {
      const ext = MIME_EXT[file.mimetype] || path.extname(file.originalname || '').toLowerCase();
      const id = crypto.randomBytes(16).toString('hex');
      cb(null, `${id}${ext}`);
    }
  });
}

const uploadPost = multer({
  storage: buildStorage('posts'),
  limits: { fileSize: MAX_BYTES_POST },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      return cb(new Error('Unsupported file type'));
    }
    cb(null, true);
  }
});

const uploadMessage = multer({
  storage: buildStorage('messages'),
  limits: { fileSize: MAX_BYTES_MESSAGE }
});

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function createAttachmentRecord({ ownerId, scope, postId, mlsGroupId, file }) {
  const relativePath = path.relative(UPLOADS_DIR, file.path).replace(/\\/g, '/');
  const sha256 = await hashFile(file.path);
  const result = await db.query(
    `INSERT INTO attachments
      (owner_id, scope, post_id, mls_group_id, content_type, size, sha256, storage_path, original_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      ownerId,
      scope,
      postId || null,
      mlsGroupId || null,
      file.mimetype,
      file.size,
      sha256,
      relativePath,
      file.originalname
    ]
  );
  return result.rows[0].id;
}

async function uploadPostImage(req, res) {
  uploadPost.single('file')(req, res, async (err) => {
    const cleanupFile = (file) => {
      if (file?.path) {
        fs.unlink(file.path, (unlinkErr) => {
          if (unlinkErr) {
            console.error('uploadPostImage cleanup error:', unlinkErr);
          }
        });
      }
    };

    if (err) {
      const message = err.message || 'Upload failed';
      cleanupFile(req.file);
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'file required' });
    }
    try {
      const attachmentId = await createAttachmentRecord({
        ownerId: req.user.id,
        scope: 'post',
        file: req.file
      });
      return res.json({
        attachmentId,
        fileName: req.file.originalname,
        contentType: req.file.mimetype,
        size: req.file.size
      });
    } catch (error) {
      console.error('uploadPostImage error:', error);
      cleanupFile(req.file);
      return res.status(500).json({ error: 'Failed to save attachment' });
    }
  });
}

async function uploadMessageAttachment(req, res) {
  uploadMessage.single('file')(req, res, async (err) => {
    const cleanupFile = (file) => {
      if (file?.path) {
        fs.unlink(file.path, (unlinkErr) => {
          if (unlinkErr) {
            console.error('uploadMessageAttachment cleanup error:', unlinkErr);
          }
        });
      }
    };

    if (err) {
      const message = err.message || 'Upload failed';
      cleanupFile(req.file);
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'file required' });
    }
    const { mls_group_id } = req.body || {};
    if (!mls_group_id) {
      cleanupFile(req.file);
      return res.status(400).json({ error: 'mls_group_id required' });
    }

    try {
      const membership = await db.query(
        'SELECT 1 FROM mls_group_members WHERE group_id = $1 AND user_id = $2',
        [mls_group_id, req.user.id]
      );
      if (membership.rows.length === 0) {
        cleanupFile(req.file);
        return res.status(403).json({ error: 'Not authorized for this MLS group' });
      }

      const attachmentId = await createAttachmentRecord({
        ownerId: req.user.id,
        scope: 'message',
        mlsGroupId: mls_group_id,
        file: req.file
      });
      return res.json({
        attachmentId,
        fileName: req.file.originalname,
        contentType: req.file.mimetype,
        size: req.file.size
      });
    } catch (error) {
      console.error('uploadMessageAttachment error:', error);
      cleanupFile(req.file);
      return res.status(500).json({ error: 'Failed to save attachment' });
    }
  });
}

async function downloadAttachment(req, res) {
  try {
    const attachmentId = parseInt(req.params.id, 10);
    if (Number.isNaN(attachmentId)) {
      return res.status(400).json({ error: 'Invalid attachment id' });
    }

    const result = await db.query(
      'SELECT * FROM attachments WHERE id = $1',
      [attachmentId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const attachment = result.rows[0];

    if (attachment.scope === 'post') {
      if (!attachment.post_id) {
        return res.status(404).json({ error: 'Attachment not linked to a post' });
      }
      // Posts are gated by JWT; no extra check yet.
    } else if (attachment.scope === 'message') {
      if (!attachment.mls_group_id) {
        return res.status(404).json({ error: 'Attachment not linked to a group' });
      }
      const membership = await db.query(
        'SELECT 1 FROM mls_group_members WHERE group_id = $1 AND user_id = $2',
        [attachment.mls_group_id, req.user.id]
      );
      if (membership.rows.length === 0) {
        return res.status(403).json({ error: 'Not authorized for this attachment' });
      }
    } else {
      return res.status(400).json({ error: 'Invalid attachment scope' });
    }

    const filePath = path.join(UPLOADS_DIR, attachment.storage_path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Attachment file missing' });
    }

    res.setHeader('Content-Type', attachment.content_type);
    res.setHeader('Content-Length', attachment.size);
    res.setHeader('Cache-Control', 'private, max-age=300');
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('downloadAttachment stream error:', err);
      res.status(500).end();
    });
    stream.pipe(res);
  } catch (error) {
    console.error('downloadAttachment error:', error);
    res.status(500).json({ error: 'Failed to download attachment' });
  }
}

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
  uploadPostImage,
  uploadMessageAttachment,
  downloadAttachment,
  presignUpload,
  presignDownload
};
