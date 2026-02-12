const db = require('../../db');

const enqueueCreateForLocalPost = async ({ post }) => {
  if (!post || !post.id) return { enqueued: 0 };
  if (post.parent_id || post.is_comment) return { enqueued: 0 };

  const inserted = await db.query(
    `INSERT INTO atproto_delivery_queue (user_id, post_id, kind, payload)
     SELECT $1, $2, 'create_post', $3
     WHERE EXISTS (
       SELECT 1
       FROM atproto_accounts
       WHERE user_id = $1
         AND is_enabled = TRUE
     )
     ON CONFLICT (user_id, post_id, kind) DO NOTHING
     RETURNING id`,
    [post.user_id, post.id, { postId: post.id }]
  );

  return {
    enqueued: inserted.rowCount || 0
  };
};

module.exports = {
  enqueueCreateForLocalPost
};
