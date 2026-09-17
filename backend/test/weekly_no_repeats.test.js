// Run against PostgreSQL with session-local tables, never production fixtures.
const { Pool } = require('pg');
jest.mock('../src/db', () => ({ getPool: jest.fn(), closePool: jest.fn() }));
jest.mock('../src/index', () => ({}));
const db = require('../src/db');
const service = require('../src/services/weeklyAssignmentService');

describe('Weekly assignments do not repeat', () => {
  let pool;
  let client;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    db.getPool.mockReturnValue({ connect: async () => ({
      query: (...args) => client.query(...args), release: () => {}
    }) });
    await client.query(`
      CREATE TEMP TABLE users (id int PRIMARY KEY, username text,
        rp_balance_ledger bigint, weekly_assignment_week text,
        weekly_assigned_event_id int, weekly_assignment_completed boolean,
        weekly_assignment_completed_at timestamp, deleted_at timestamp);
      CREATE TEMP TABLE events (id int PRIMARY KEY, title text,
        closing_date timestamp, market_prob float, outcome text,
        hidden_at timestamp, event_type text);
      CREATE TEMP TABLE predictions (id int, user_id int, event_id int);
      CREATE TEMP TABLE event_topics (event_id int, topic_id int);
      CREATE TEMP TABLE event_outcomes (event_id int, is_active boolean);
      CREATE TEMP TABLE user_topics (user_id int, topic_id int);
      CREATE TEMP TABLE weekly_user_assignments (user_id int, week_year text,
        event_id int, required_stake_ledger bigint, completed boolean,
        completed_at timestamp, penalty_applied boolean,
        penalty_amount_ledger bigint, updated_at timestamp,
        PRIMARY KEY (user_id, week_year));
    `);
  });

  beforeEach(async () => {
    await client.query(`
      DELETE FROM pg_temp.weekly_user_assignments;
      DELETE FROM pg_temp.predictions;
      DELETE FROM pg_temp.users;
      DELETE FROM pg_temp.events;
      DELETE FROM pg_temp.event_topics;
      DELETE FROM pg_temp.user_topics;
      INSERT INTO users (id, username, rp_balance_ledger) VALUES (1, 'test', 100000000);
      INSERT INTO events (id, title, closing_date, market_prob, event_type)
        VALUES (10, 'old', NOW() + INTERVAL '30 days', 0.5, 'binary'),
               (20, 'fresh', NOW() + INTERVAL '30 days', 0.5, 'binary');
      INSERT INTO user_topics VALUES (1, 100);
      INSERT INTO event_topics VALUES (10, 100);
    `);
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  test.each([false, true])('excludes previous assignments with completed=%s and falls back outside topics', async (completed) => {
    await client.query(`INSERT INTO weekly_user_assignments
      (user_id, week_year, event_id, completed) VALUES (1, '2025-W01', 10, $1)`, [completed]);
    expect((await service.assignWeeklyPredictions({ userIds: [1] })).assigned).toBe(1);
    const result = await client.query('SELECT weekly_assigned_event_id FROM users WHERE id = 1');
    expect(result.rows[0].weekly_assigned_event_id).toBe(20);
    expect((await service.assignWeeklyPredictions({ userIds: [1] })).assigned).toBe(0);
  });

  test('excludes the legacy assignment pointer when history is missing', async () => {
    await client.query("UPDATE users SET weekly_assigned_event_id = 10, weekly_assignment_week = '2025-W01'");
    await service.assignWeeklyPredictions({ userIds: [1] });
    const result = await client.query('SELECT weekly_assigned_event_id FROM users');
    expect(result.rows[0].weekly_assigned_event_id).toBe(20);
  });

  test('does not recycle questions when history and predictions exhaust the pool', async () => {
    await client.query(`INSERT INTO weekly_user_assignments
      (user_id, week_year, event_id) VALUES (1, '2025-W01', 10);
      INSERT INTO predictions VALUES (1, 1, 20)`);
    expect((await service.assignWeeklyPredictions({ userIds: [1] })).assigned).toBe(0);
    const result = await client.query('SELECT weekly_assignment_week FROM users');
    expect(result.rows[0].weekly_assignment_week).toBeNull();
  });

  test('another user having received a question does not exclude it', async () => {
    await client.query(`INSERT INTO weekly_user_assignments
      (user_id, week_year, event_id) VALUES (2, '2025-W01', 10)`);
    await service.assignWeeklyPredictions({ userIds: [1] });
    const result = await client.query('SELECT weekly_assigned_event_id FROM users');
    expect(result.rows[0].weekly_assigned_event_id).toBe(10);
  });
});
