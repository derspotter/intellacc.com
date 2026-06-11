const db = require('../src/db');
const mlsService = require('../src/services/mlsService');

describe('MLS security hardening', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('key package upload requires an active verified device', async () => {
    jest.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    await expect(
      mlsService.upsertKeyPackage(
        42,
        '11111111-1111-1111-1111-111111111111',
        Buffer.from('package'),
        'hash',
        null,
        null,
        false
      )
    ).rejects.toThrow('Active verified device required');
  });

  test('bulk key package fetch consumes regular (one-time) packages', async () => {
    const spy = jest.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    await mlsService.getKeyPackages(42);

    const sql = String(spy.mock.calls[0][0]);
    expect(sql).toContain('DELETE FROM mls_key_packages');
    expect(sql).toContain('is_last_resort = false');
  });

  test('welcome for a DM group rejects receivers outside the DM', async () => {
    jest.spyOn(db, 'query').mockImplementation(async (sql) => {
      if (String(sql).includes('FROM mls_group_members')) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (String(sql).includes('FROM mls_direct_messages')) {
        return { rows: [{ user_a_id: 1, user_b_id: 2 }] };
      }
      return { rows: [] };
    });

    await expect(
      mlsService.storeWelcomeMessage('dm_1_2', 10, 1, 3, Buffer.from('welcome'))
    ).rejects.toThrow('Receiver is not part of this direct message');
  });

  test('concurrent DM creation returns existing group instead of failing', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    const client = {
      query: jest.fn(async (sql) => {
        if (String(sql).startsWith('INSERT INTO mls_groups')) {
          throw uniqueViolation;
        }
        return { rows: [] };
      }),
      release: jest.fn()
    };
    jest.spyOn(db, 'getPool').mockReturnValue({
      connect: jest.fn(async () => client)
    });

    await expect(mlsService.createDirectMessage(2, 1)).resolves.toEqual({
      groupId: 'dm_1_2',
      isNew: false
    });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  test('ackMessages does not add group membership for guessed queue ids', async () => {
    const queries = [];
    const client = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (String(sql).includes('WITH updated AS')) {
          return { rows: [] };
        }
        if (String(sql).includes('SELECT id FROM mls_relay_queue')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: jest.fn()
    };

    jest.spyOn(db, 'getPool').mockReturnValue({
      connect: jest.fn(async () => client)
    });

    await mlsService.ackMessages([77], [12345]);

    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(queries.some((sql) => String(sql).includes('INSERT INTO mls_group_members'))).toBe(false);
  });
});
