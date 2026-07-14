const db = require('../src/db');

jest.setTimeout(30000);

const createEvent = async () => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Numeric schema test ${Date.now()}_${Math.floor(Math.random() * 10000)}`, 'schema test', new Date(Date.now() + 24 * 60 * 60 * 1000)]
  );
  return result.rows[0].id;
};

const createUser = async () => {
  const unique = `numschema_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const result = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at)
     VALUES ($1, $2, $3, NOW()) RETURNING id`,
    [`${unique}@example.com`, unique, 'x']
  );
  return result.rows[0].id;
};

const columnsOf = async (tableName) => {
  const result = await db.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return result.rows.reduce((acc, row) => {
    acc[row.column_name] = row;
    return acc;
  }, {});
};

describe('numeric market schema', () => {
  const cleanup = {
    events: new Set(),
    users: new Set()
  };

  afterAll(async () => {
    for (const eventId of cleanup.events) {
      await db.query('DELETE FROM events WHERE id = $1', [eventId]);
    }
    for (const userId of cleanup.users) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  test('numeric_market_config table exists with expected columns', async () => {
    const columns = await columnsOf('numeric_market_config');

    expect(Object.keys(columns).length).toBeGreaterThan(0);
    expect(columns.event_id).toBeDefined();
    expect(columns.range_min).toBeDefined();
    expect(columns.range_max).toBeDefined();
    expect(columns.zero_point).toBeDefined();
    expect(columns.open_lower_bound.is_nullable).toBe('NO');
    expect(columns.open_upper_bound.is_nullable).toBe('NO');
    expect(columns.unit).toBeDefined();
    expect(columns.bin_count.is_nullable).toBe('NO');
    expect(columns.transform.is_nullable).toBe('NO');
    expect(columns.binning_version.is_nullable).toBe('NO');
    expect(columns.b_numeric.is_nullable).toBe('NO');
    expect(columns.numeric_market_version.is_nullable).toBe('NO');
    expect(columns.created_at).toBeDefined();
  });

  test('distribution_trades table exists with expected columns', async () => {
    const columns = await columnsOf('distribution_trades');

    expect(Object.keys(columns).length).toBeGreaterThan(0);
    expect(columns.id).toBeDefined();
    expect(columns.user_id.is_nullable).toBe('NO');
    expect(columns.event_id.is_nullable).toBe('NO');
    expect(columns.total_cost_ledger.is_nullable).toBe('NO');
    expect(columns.alpha).toBeDefined();
    expect(columns.target_distribution).toBeDefined();
    expect(columns.target_distribution.data_type).toBe('jsonb');
    expect(columns.pre_market_version.is_nullable).toBe('NO');
    expect(columns.post_market_version.is_nullable).toBe('NO');
    expect(columns.hold_until).toBeDefined();
    expect(columns.created_at).toBeDefined();
  });

  test('distribution_trade_legs table exists with expected columns', async () => {
    const columns = await columnsOf('distribution_trade_legs');

    expect(Object.keys(columns).length).toBeGreaterThan(0);
    expect(columns.trade_id.is_nullable).toBe('NO');
    expect(columns.outcome_id.is_nullable).toBe('NO');
    expect(columns.shares_delta.is_nullable).toBe('NO');
  });

  test('numeric_market_config enforces FK to events and can be inserted', async () => {
    const eventId = await createEvent();
    cleanup.events.add(eventId);

    await db.query(
      `INSERT INTO numeric_market_config
        (event_id, range_min, range_max, zero_point, open_lower_bound, open_upper_bound, unit, bin_count, transform, binning_version, b_numeric, numeric_market_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [eventId, 0, 100, null, false, false, 'usd', 50, 'linear', 1, 10.0, 0]
    );

    const result = await db.query(
      'SELECT * FROM numeric_market_config WHERE event_id = $1',
      [eventId]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].bin_count).toBe(50);

    await db.query('DELETE FROM numeric_market_config WHERE event_id = $1', [eventId]);
  });

  test('distribution_trades and distribution_trade_legs support inserts with FKs to users/events/event_outcomes', async () => {
    const eventId = await createEvent();
    const userId = await createUser();
    cleanup.events.add(eventId);
    cleanup.users.add(userId);

    const outcomeResult = await db.query(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [eventId, 'bin_0', 'Bin 0', 0]
    );
    const outcomeId = outcomeResult.rows[0].id;

    const tradeResult = await db.query(
      `INSERT INTO distribution_trades
        (user_id, event_id, total_cost_ledger, alpha, target_distribution, pre_market_version, post_market_version, hold_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [userId, eventId, 1000, 0.5, JSON.stringify({ bin_0: 1.0 }), 0, 1, new Date(Date.now() + 60 * 60 * 1000)]
    );
    const tradeId = tradeResult.rows[0].id;

    await db.query(
      `INSERT INTO distribution_trade_legs (trade_id, outcome_id, shares_delta)
       VALUES ($1, $2, $3)`,
      [tradeId, outcomeId, 3.5]
    );

    const legs = await db.query(
      'SELECT * FROM distribution_trade_legs WHERE trade_id = $1',
      [tradeId]
    );
    expect(legs.rows).toHaveLength(1);
    expect(Number(legs.rows[0].shares_delta)).toBeCloseTo(3.5);

    // ON DELETE CASCADE from distribution_trades to legs
    await db.query('DELETE FROM distribution_trades WHERE id = $1', [tradeId]);
    const legsAfterDelete = await db.query(
      'SELECT * FROM distribution_trade_legs WHERE trade_id = $1',
      [tradeId]
    );
    expect(legsAfterDelete.rows).toHaveLength(0);
  });

  test('distribution_trades has helpful indexes', async () => {
    const result = await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'distribution_trades'`
    );
    const indexNames = result.rows.map((r) => r.indexname);
    expect(indexNames).toContain('idx_distribution_trades_event');
    expect(indexNames).toContain('idx_distribution_trades_user');
  });
});
