const db = require('../src/db');
const webauthnController = require('../src/controllers/webauthnController');

jest.mock('../src/utils/jwt', () => ({
    generateToken: jest.fn(() => 'mock-jwt-token')
}));

jest.mock('@simplewebauthn/server', () => ({
    generateRegistrationOptions: jest.fn(),
    verifyRegistrationResponse: jest.fn(),
    generateAuthenticationOptions: jest.fn(),
    verifyAuthenticationResponse: jest.fn()
}));

const { generateAuthenticationOptions, generateRegistrationOptions } = require('@simplewebauthn/server');
const { verifyAuthenticationResponse, verifyRegistrationResponse } = require('@simplewebauthn/server');

describe('WebAuthn PRF contract', () => {
    let queryMock;

    beforeEach(() => {
        queryMock = jest.spyOn(db, 'query').mockImplementation(async (sql) => {
            if (sql.includes('SELECT id FROM users WHERE email')) {
                return { rows: [{ id: 42 }] };
            }
            if (sql.includes('SELECT credential_id FROM webauthn_credentials WHERE user_id')) {
                return { rows: [] };
            }
            if (sql.includes('SELECT username, email FROM users')) {
                return { rows: [{ username: 'test-user', email: 'user@example.com' }] };
            }
            if (sql.includes('SELECT * FROM webauthn_credentials WHERE credential_id')) {
                return {
                    rows: [{
                        id: 11,
                        user_id: 42,
                        public_key: Buffer.from([9, 9, 9, 9]),
                        counter: 4
                    }]
                };
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
                return { rows: [{ id: 42, role: 'user' }] };
            }
            if (sql.includes('INSERT INTO webauthn_credentials')) {
                return { rowCount: 1 };
            }
            if (sql.includes('UPDATE webauthn_credentials SET counter')) {
                return { rowCount: 1 };
            }

            return { rows: [] };
        });
    });

    afterEach(() => {
        queryMock.mockRestore();
        jest.clearAllMocks();
    });

    test('verifyAuthentication returns prfOutput and userId from verified auth response', async () => {
        generateAuthenticationOptions.mockResolvedValue({ challenge: 'auth-challenge' });

        const optionsReq = {
            body: { email: 'user@example.com' }
        };
        const optionsRes = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis()
        };

        await webauthnController.generateAuthenticationOptions(optionsReq, optionsRes);
        expect(optionsRes.json).toHaveBeenCalledWith({ challenge: 'auth-challenge' });

        verifyAuthenticationResponse.mockResolvedValue({
            verified: true,
            authenticationInfo: {
                newCounter: 8,
                authenticatorExtensionResults: {
                    prf: {
                        results: {
                            first: new Uint8Array([1, 2, 3, 4])
                        }
                    }
                }
            }
        });

        const authReq = {
            body: {
                challenge: 'auth-challenge',
                id: Buffer.from('cred-id').toString('base64url')
            }
        };
        const authRes = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis()
        };

        await webauthnController.verifyAuthentication(authReq, authRes);

        expect(verifyAuthenticationResponse).toHaveBeenCalled();
        expect(authRes.json).toHaveBeenCalledWith({
            verified: true,
            token: 'mock-jwt-token',
            userId: 42,
            prfOutput: [1, 2, 3, 4]
        });
    });

    test('verifyRegistration returns base64url credentialID', async () => {
        generateRegistrationOptions.mockResolvedValue({ challenge: 'register-challenge' });

        const optionsReq = {
            user: { id: 42 }
        };
        const optionsRes = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis()
        };
        await webauthnController.generateRegistrationOptions(optionsReq, optionsRes);
        expect(optionsRes.json).toHaveBeenCalledWith({ challenge: 'register-challenge' });

        verifyRegistrationResponse.mockResolvedValue({
            verified: true,
            registrationInfo: {
                credentialPublicKey: new Uint8Array([4, 3, 2, 1]),
                credentialID: new Uint8Array([9, 8, 7, 6]),
                counter: 5
            }
        });

        const registerReq = {
            user: { id: 42 },
            body: {
                challenge: 'register-challenge',
                response: {},
                name: 'My Passkey',
                clientExtensionResults: {}
            }
        };
        const registerRes = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis()
        };

        await webauthnController.verifyRegistration(registerReq, registerRes);
        expect(verifyRegistrationResponse).toHaveBeenCalled();
        expect(registerRes.json).toHaveBeenCalledWith({
            verified: true,
            credentialID: Buffer.from([9, 8, 7, 6]).toString('base64url')
        });
    });
});
