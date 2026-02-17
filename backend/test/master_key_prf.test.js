const db = require('../src/db');
const userController = require('../src/controllers/userController');

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
});
