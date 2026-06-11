const db = require('../src/db');
const bcrypt = require('bcryptjs');
const userController = require('../src/controllers/userController');
const deviceController = require('../src/controllers/deviceController');

describe('Master key API', () => {
    let queryMock;

    beforeEach(() => {
        queryMock = jest.spyOn(db, 'query').mockImplementation(async (sql) => {
            if (sql.includes('SELECT wrapped_key, salt, iv, wrapped_key_prf, salt_prf, iv_prf, updated_at FROM user_master_keys')) {
                return {
                    rows: [{
                        wrapped_key: 'wrapped',
                        salt: 'salt',
                        iv: 'iv',
                        wrapped_key_prf: 'wrapped-prf',
                        salt_prf: 'salt-prf',
                        iv_prf: 'iv-prf',
                        updated_at: new Date()
                    }]
                };
            }

            if (sql.includes('SELECT id, device_public_id, last_verified_at FROM user_devices')) {
                return {
                    rows: [{
                        id: 55,
                        device_public_id: '11111111-1111-1111-1111-111111111111',
                        last_verified_at: new Date()
                    }]
                };
            }

            return { rows: [] };
        });
    });

    afterEach(() => {
        queryMock.mockRestore();
        jest.clearAllMocks();
    });

    test('returns password and PRF wrapped values in getMasterKey response', async () => {
        const req = {
            user: { id: 99 },
            headers: {
                'x-device-ids': '11111111-1111-1111-1111-111111111111'
            }
        };

        const res = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis()
        };

        await userController.getMasterKey(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            wrapped_key: 'wrapped',
            salt: 'salt',
            iv: 'iv',
            wrapped_key_prf: 'wrapped-prf',
            salt_prf: 'salt-prf',
            iv_prf: 'iv-prf',
            deviceId: '11111111-1111-1111-1111-111111111111'
        }));
    });

    test('setMasterKey rejects writes without password reauth', async () => {
        const req = {
            user: { id: 99 },
            headers: {},
            body: { wrapped_key: 'wrapped', salt: 'salt', iv: 'iv' }
        };
        const res = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis()
        };

        await userController.setMasterKey(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'current_password is required' });
        expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE user_master_keys'), expect.anything());
    });
});

describe('Master key write hardening', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    const makeResponse = () => ({
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
    });

    test('PRF-only update requires password and verified device without bumping updated_at', async () => {
        const compareMock = jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
        const queries = [];
        jest.spyOn(db, 'query').mockImplementation(async (sql, params) => {
            queries.push({ sql: String(sql), params });
            if (String(sql).includes('SELECT password_hash FROM users')) {
                return { rows: [{ password_hash: 'hash' }] };
            }
            if (String(sql).includes('SELECT 1 FROM user_master_keys')) {
                return { rows: [{ '?column?': 1 }] };
            }
            if (String(sql).includes('FROM user_devices')) {
                return { rows: [{ id: 55 }] };
            }
            return { rows: [] };
        });

        const req = {
            user: { id: 99 },
            headers: { 'x-device-id': '11111111-1111-1111-1111-111111111111' },
            body: {
                wrapped_key_prf: 'wrapped-prf',
                salt_prf: 'salt-prf',
                iv_prf: 'iv-prf',
                current_password: 'password123'
            }
        };
        const res = makeResponse();

        await userController.setMasterKey(req, res);

        const update = queries.find((entry) => entry.sql.includes('UPDATE user_master_keys SET'));
        expect(compareMock).toHaveBeenCalledWith('password123', 'hash');
        expect(update.sql).toContain('wrapped_key_prf');
        expect(update.sql).not.toContain('updated_at = NOW()');
        expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    test('password-wrap update bumps updated_at', async () => {
        jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
        const queries = [];
        jest.spyOn(db, 'query').mockImplementation(async (sql, params) => {
            queries.push({ sql: String(sql), params });
            if (String(sql).includes('SELECT password_hash FROM users')) {
                return { rows: [{ password_hash: 'hash' }] };
            }
            if (String(sql).includes('SELECT 1 FROM user_master_keys')) {
                return { rows: [{ '?column?': 1 }] };
            }
            if (String(sql).includes('FROM user_devices')) {
                return { rows: [{ id: 55 }] };
            }
            return { rows: [] };
        });

        const req = {
            user: { id: 99 },
            headers: { 'x-device-id': '11111111-1111-1111-1111-111111111111' },
            body: {
                wrapped_key: 'wrapped',
                salt: 'salt',
                iv: 'iv',
                current_password: 'password123'
            }
        };
        const res = makeResponse();

        await userController.setMasterKey(req, res);

        const update = queries.find((entry) => entry.sql.includes('UPDATE user_master_keys SET'));
        expect(update.sql).toContain('wrapped_key');
        expect(update.sql).toContain('updated_at = NOW()');
        expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    test('existing master key update rejects unverified caller device', async () => {
        jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
        jest.spyOn(db, 'query').mockImplementation(async (sql) => {
            if (String(sql).includes('SELECT password_hash FROM users')) {
                return { rows: [{ password_hash: 'hash' }] };
            }
            if (String(sql).includes('SELECT 1 FROM user_master_keys')) {
                return { rows: [{ '?column?': 1 }] };
            }
            if (String(sql).includes('FROM user_devices')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        const req = {
            user: { id: 99 },
            headers: { 'x-device-id': '11111111-1111-1111-1111-111111111111' },
            body: {
                wrapped_key: 'wrapped',
                salt: 'salt',
                iv: 'iv',
                current_password: 'password123'
            }
        };
        const res = makeResponse();

        await userController.setMasterKey(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Verified device required' });
    });

    test('first setup requires password-wrapped master key', async () => {
        jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
        jest.spyOn(db, 'query').mockImplementation(async (sql) => {
            if (String(sql).includes('SELECT password_hash FROM users')) {
                return { rows: [{ password_hash: 'hash' }] };
            }
            if (String(sql).includes('SELECT 1 FROM user_master_keys')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        const req = {
            user: { id: 99 },
            headers: {},
            body: {
                wrapped_key_prf: 'wrapped-prf',
                salt_prf: 'salt-prf',
                iv_prf: 'iv-prf',
                current_password: 'password123'
            }
        };
        const res = makeResponse();

        await userController.setMasterKey(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Password-wrapped master key required for first setup' });
    });

    test('registerInitialDevice does not auto-trust when master key already exists', async () => {
        const queries = [];
        jest.spyOn(db, 'query').mockImplementation(async (sql, params) => {
            queries.push({ sql: String(sql), params });
            if (String(sql).includes('SELECT count(*) FROM user_devices')) {
                return { rows: [{ count: '0' }] };
            }
            if (String(sql).includes('SELECT 1 FROM user_master_keys')) {
                return { rows: [{ '?column?': 1 }] };
            }
            if (String(sql).includes('INSERT INTO user_devices')) {
                return { rows: [{ id: 55, is_primary: false, last_verified_at: null }] };
            }
            return { rows: [] };
        });

        const device = await deviceController.registerInitialDevice(
            99,
            '11111111-1111-1111-1111-111111111111',
            'Recovered Browser'
        );

        const insert = queries.find((entry) => entry.sql.includes('INSERT INTO user_devices'));
        expect(insert.params[3]).toBe(false);
        expect(device.last_verified_at).toBeNull();
    });
});
