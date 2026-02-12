const db = require('../../db');

const enqueueDelivery = async ({ targetUrl, signingKeyId, payload }) => {
  if (!targetUrl) throw new Error('Missing targetUrl');
  if (!signingKeyId) throw new Error('Missing signingKeyId');
  if (!payload) throw new Error('Missing payload');

  const result = await db.query(
    `INSERT INTO federation_delivery_queue (protocol, target_url, signing_key_id, payload)
     VALUES ('ap', $1, $2, $3)
     RETURNING id`,
    [targetUrl, signingKeyId, payload]
  );

  return result.rows[0]?.id;
};

module.exports = {
  enqueueDelivery
};

