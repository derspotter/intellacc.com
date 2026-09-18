jest.mock('../src/services/pushNotificationService', () => ({
  sendMessagePush: jest.fn().mockResolvedValue(undefined)
}));

const { randomUUID } = require('crypto');
const db = require('../src/db');
const mlsService = require('../src/services/mlsService');

jest.setTimeout(15000);

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const waitFor = async (check) => {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Concurrent transaction did not reach the expected barrier');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('MLS invitation acceptance and relay fanout', () => {
  let alice, bob, aliceDevice, bobDevice;
  const groups = [];
  const emit = jest.fn();

  const createGroup = async () => {
    const groupId = `race_${randomUUID()}`;
    groups.push(groupId);
    await db.query('INSERT INTO mls_groups (group_id, created_by) VALUES ($1, $2)', [groupId, alice]);
    await db.query('INSERT INTO mls_group_members (group_id, user_id) VALUES ($1, $2)', [groupId, alice]);
    const welcome = await mlsService.storeWelcomeMessage(groupId, aliceDevice, alice, bob, Buffer.from('welcome'), null, 2);
    return { groupId, welcomeId: Number(welcome.queueId) };
  };
  const send = (groupId, type = 'application', epoch = 2) => mlsService.storeGroupMessage(
    groupId, aliceDevice, alice, type, Buffer.from('first message'), { epoch }
  );
  const ack = (welcomeIds) => mlsService.ackMessages([bobDevice], welcomeIds);

  beforeAll(async () => {
    const users = [];
    const devices = [];
    for (const tag of ['alice', 'bob']) {
      const name = `race_${tag}_${randomUUID().slice(0, 8)}`;
      const user = (await db.query(
        "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'test') RETURNING id",
        [name, `${name}@example.test`]
      )).rows[0].id;
      users.push(user);
      devices.push((await db.query(
        "INSERT INTO user_devices (user_id, device_public_id, name, last_verified_at) VALUES ($1, gen_random_uuid(), 'race test', NOW()) RETURNING id",
        [user]
      )).rows[0].id);
    }
    [alice, bob] = users;
    [aliceDevice, bobDevice] = devices;
    mlsService.setSocketIo({ to: () => ({ emit }) });
  });

  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    mlsService.setSocketIo(null);
    await db.query('DELETE FROM mls_relay_queue WHERE group_id = ANY($1::text[])', [groups]);
    await db.query('DELETE FROM mls_groups WHERE group_id = ANY($1::text[])', [groups]);
    await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [[alice, bob]]);
  });

  // Pause a real transaction after its fanout/backfill snapshot, before commit.
  // On the buggy implementation the competing operation completes, missing its
  // uncommitted work. With serialization it blocks in PostgreSQL until release.
  // Observe actual lock waiters instead of guessing at scheduling with sleeps.
  const overlap = async (first, second, pauseAfter, whilePaused = async () => {}) => {
    const pool = db.getPool();
    const reached = deferred();
    const release = deferred();
    let firstPid;
    let connections = 0;
    let secondDone = false;
    const pending = [];
    jest.spyOn(db, 'getPool').mockReturnValue({
      connect: async () => {
        const client = await pool.connect();
        const isFirst = connections++ === 0;
        if (isFirst) firstPid = client.processID;
        return {
          release: () => client.release(),
          query: async (sql, params) => {
            const result = await client.query(sql, params);
            if (isFirst && pauseAfter(String(sql))) {
              reached.resolve();
              await release.promise;
            }
            return result;
          }
        };
      }
    });
    const start = (operation) => {
      const promise = operation();
      promise.catch(() => {});
      pending.push(promise);
      return promise;
    };
    try {
      start(first);
      await Promise.race([reached.promise, pending[0].then(() => { throw new Error('Missing transaction barrier'); })]);
      emit.mockClear();
      start(second).finally(() => { secondDone = true; }).catch(() => {});
      await waitFor(async () => secondDone || (await pool.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [firstPid]
      )).rows.length > 0);
      await whilePaused();
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      jest.restoreAllMocks();
    }
    return Promise.all(pending);
  };

  test.each(['application', 'commit'])('send-first overlap delivers the first %s exactly once', async (type) => {
    const { groupId, welcomeId } = await createGroup();
    const unrelated = await createGroup();
    const [message] = await overlap(
      () => send(groupId, type),
      () => ack([welcomeId]),
      (sql) => sql.includes('SELECT ud.id, ud.user_id FROM user_devices'),
      async () => {
        // Holding one conversation must not stall sends in another.
        await send(unrelated.groupId);
      }
    );
    const pending = await mlsService.getPendingMessages([bobDevice]);
    expect(pending.filter((row) => Number(row.id) === Number(message.queueId))).toHaveLength(1);
    const recipients = await db.query('SELECT * FROM mls_relay_recipients WHERE queue_id = $1 AND recipient_device_id = $2', [message.queueId, bobDevice]);
    expect(recipients.rows).toHaveLength(1);
    await ack([welcomeId]);
    expect((await mlsService.getPendingMessages([bobDevice])).filter((row) => Number(row.id) === Number(message.queueId))).toHaveLength(1);
  });

  test('ack-first overlap delivers a message sent before membership commits', async () => {
    const { groupId, welcomeId } = await createGroup();
    const [, message] = await overlap(
      () => ack([welcomeId]),
      () => send(groupId),
      (sql) => sql.includes('CROSS JOIN unnest($2::int[])'),
      async () => {
        expect(await mlsService.isGroupMember(groupId, bob)).toBe(false);
        expect(emit).not.toHaveBeenCalled();
      }
    );
    expect((await mlsService.getPendingMessages([bobDevice])).filter((row) => Number(row.id) === Number(message.queueId))).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith('mls-message', { groupId });
  });

  test('welcome gating, epoch filtering and acknowledgement cleanup are preserved', async () => {
    const { groupId, welcomeId } = await createGroup();
    const oldCommit = await send(groupId, 'commit', 1);
    const newCommit = await send(groupId, 'commit', 2);
    const message = await send(groupId);
    const forGroup = async () => (await mlsService.getPendingMessages([bobDevice]))
      .filter((row) => row.group_id === groupId).map((row) => Number(row.id));
    expect(await forGroup()).toEqual([welcomeId]);
    await ack([welcomeId]);
    expect(await forGroup()).toEqual([Number(newCommit.queueId), Number(message.queueId)]);
    expect(await forGroup()).not.toContain(Number(oldCommit.queueId));
    await ack([newCommit.queueId, message.queueId]);
    expect(await forGroup()).toEqual([]);
  });

  test('overlapping acknowledgement batches accept groups in either input order', async () => {
    const first = await createGroup();
    const second = await createGroup();
    const messages = await Promise.all([send(first.groupId), send(second.groupId)]);
    await overlap(
      () => ack([first.welcomeId, second.welcomeId]),
      () => ack([second.welcomeId, first.welcomeId]),
      (sql) => sql.includes('WITH updated AS')
    );
    const pending = await mlsService.getPendingMessages([bobDevice]);
    for (const message of messages) {
      expect(pending.filter((row) => Number(row.id) === Number(message.queueId))).toHaveLength(1);
    }
  });

  test('a second device can accept later and still receive the first message', async () => {
    const secondDevice = (await db.query(
      "INSERT INTO user_devices (user_id, device_public_id, name, last_verified_at) VALUES ($1, gen_random_uuid(), 'second device', NOW()) RETURNING id",
      [bob]
    )).rows[0].id;
    const { groupId, welcomeId } = await createGroup();
    const [message] = await overlap(
      () => send(groupId),
      () => ack([welcomeId]),
      (sql) => sql.includes('SELECT ud.id, ud.user_id FROM user_devices')
    );
    const pendingOnSecondDevice = async () => (await mlsService.getPendingMessages([secondDevice]))
      .filter((row) => row.group_id === groupId).map((row) => Number(row.id));
    expect(await pendingOnSecondDevice()).toEqual([welcomeId]);
    await ack([message.queueId]);
    await mlsService.ackMessages([secondDevice], [welcomeId]);
    expect(await pendingOnSecondDevice()).toEqual([Number(message.queueId)]);
    await mlsService.ackMessages([secondDevice], [message.queueId]);
    expect(await pendingOnSecondDevice()).toEqual([]);
  });

  test('a guessed welcome ID does not grant membership or consume the invitation', async () => {
    const { groupId, welcomeId } = await createGroup();
    await mlsService.ackMessages([aliceDevice], [welcomeId]);
    expect(await mlsService.isGroupMember(groupId, bob)).toBe(false);
    expect((await mlsService.getPendingMessages([bobDevice])).filter((row) => Number(row.id) === welcomeId)).toHaveLength(1);
    await ack([welcomeId]);
    expect(await mlsService.isGroupMember(groupId, bob)).toBe(true);
  });

  test('a failed send rolls back its relay row and releases the conversation lock', async () => {
    const { groupId, welcomeId } = await createGroup();
    const pool = db.getPool();
    jest.spyOn(db, 'getPool').mockReturnValue({
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: (sql, params) => {
            if (String(sql).includes('SELECT ud.id, ud.user_id FROM user_devices')) {
              throw new Error('Simulated fanout failure');
            }
            return client.query(sql, params);
          }
        };
      }
    });
    await expect(send(groupId)).rejects.toThrow('Simulated fanout failure');
    jest.restoreAllMocks();
    expect((await db.query("SELECT id FROM mls_relay_queue WHERE group_id = $1 AND message_type = 'application'", [groupId])).rows).toHaveLength(0);
    await ack([welcomeId]);
    const message = await send(groupId);
    expect((await mlsService.getPendingMessages([bobDevice])).filter((row) => Number(row.id) === Number(message.queueId))).toHaveLength(1);
  });

  test('resetting a DM during an acknowledgement does not deadlock', async () => {
    const { groupId, welcomeId } = await createGroup();
    await db.query(
      'INSERT INTO mls_direct_messages (group_id, user_a_id, user_b_id, created_by) VALUES ($1, $2, $3, $2)',
      [groupId, alice, bob]
    );
    await overlap(
      () => ack([welcomeId]),
      () => mlsService.resetUserState(bob),
      (sql) => sql.includes('pg_advisory_xact_lock')
    );
    expect((await db.query('SELECT group_id FROM mls_groups WHERE group_id = $1', [groupId])).rows).toHaveLength(0);
  });
});
