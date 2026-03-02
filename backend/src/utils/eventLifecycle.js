const db = require('../db');

const ensureEventIsActive = async (eventId) => {
  const eventResult = await db.query(
    'SELECT outcome, closing_date FROM events WHERE id = $1',
    [eventId]
  );

  if (eventResult.rows.length === 0) {
    return { status: 404, payload: { message: 'Event not found' } };
  }

  const { outcome, closing_date } = eventResult.rows[0];
  if (outcome) {
    return { status: 400, payload: { error: 'Market resolved', event_id: eventId } };
  }

  if (closing_date && new Date(closing_date).getTime() <= Date.now()) {
    return { status: 400, payload: { error: 'Market closed', event_id: eventId } };
  }

  return { status: 200, payload: null };
};

module.exports = {
  ensureEventIsActive
};
