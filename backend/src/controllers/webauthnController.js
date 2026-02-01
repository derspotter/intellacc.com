const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const db = require('../db');
const { generateToken } = require('../utils/jwt');
const crypto = require('crypto');

// Configuration
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173';

// In-memory challenge store (simple implementation)
const challengeStore = new Map();

// Cleanup every minute
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [challenge, data] of challengeStore.entries()) {
    if (data.expires < now) {
      challengeStore.delete(challenge);
    }
  }
}, 60000);
cleanupInterval.unref();

const storeChallenge = (challenge, userId = null) => {
  challengeStore.set(challenge, {
    userId,
    expires: Date.now() + 5 * 60 * 1000 // 5 minutes
  });
};

const getChallenge = (challenge) => {
  return challengeStore.get(challenge);
};

const removeChallenge = (challenge) => {
  challengeStore.delete(challenge);
};

// --- Registration ---

exports.generateRegistrationOptions = async (req, res) => {
  const userId = req.user.id;
  
  try {
    const userResult = await db.query('SELECT username, email FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];

    // Get existing credentials to exclude
    const credsResult = await db.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = $1', [userId]);
    
    const excludeCredentials = credsResult.rows.map(row => ({
      id: row.credential_id, // Postgres BYTEA returns Buffer
      type: 'public-key',
      transports: ['internal'],
    }));

    const options = await generateRegistrationOptions({
      rpName: 'Intellacc',
      rpID: RP_ID,
      userID: String(userId),
      userName: user.username,
      userDisplayName: user.email,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        authenticatorAttachment: 'platform',
      },
      extensions: {
         prf: {
             eval: {
                 first: crypto.randomBytes(32)
             }
         }
      }
    });

    storeChallenge(options.challenge, userId);

    res.json(options);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

exports.verifyRegistration = async (req, res) => {
  const userId = req.user.id;
  const { body } = req;

  const expectedChallenge = body.challenge || req.headers['x-challenge']; 
  
  if (!expectedChallenge) {
      return res.status(400).json({ error: 'Challenge required' });
  }
  
  const challengeData = getChallenge(expectedChallenge);
  if (!challengeData || challengeData.userId !== userId) {
      return res.status(400).json({ error: 'Invalid or expired challenge' });
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });

    if (verification.verified && verification.registrationInfo) {
      const { credentialPublicKey, credentialID, counter } = verification.registrationInfo;
      
      const supportsPrf = body.clientExtensionResults?.prf?.enabled || false;

      await db.query(
        `INSERT INTO webauthn_credentials 
        (user_id, credential_id, public_key, counter, transports, supports_prf, name) 
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            userId, 
            Buffer.from(credentialID), 
            Buffer.from(credentialPublicKey), 
            counter, 
            body.response.transports || [], 
            supportsPrf,
            req.body.name || 'Passkey'
        ]
      );

      removeChallenge(expectedChallenge);
      res.json({ verified: true });
    } else {
      res.status(400).json({ verified: false, error: 'Verification failed' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

// --- Authentication ---

exports.generateAuthenticationOptions = async (req, res) => {
  const { email } = req.body;
  
  try {
    let allowCredentials = [];
    let userId = null;

    if (email) {
       const userRes = await db.query('SELECT id FROM users WHERE email = $1', [email]);
       if (userRes.rows.length > 0) {
           userId = userRes.rows[0].id;
           const creds = await db.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = $1', [userId]);
           allowCredentials = creds.rows.map(row => ({
               id: row.credential_id,
               type: 'public-key',
               transports: ['internal'],
           }));
       }
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials,
      userVerification: 'preferred',
      extensions: {
          prf: {} 
      }
    });
    
    storeChallenge(options.challenge, userId);
    res.json(options);
  } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
  }
};

exports.verifyAuthentication = async (req, res) => {
  const { body } = req;
  const expectedChallenge = body.challenge || req.headers['x-challenge'];
  
  if (!expectedChallenge) return res.status(400).json({ error: 'Challenge required' });
  
  const challengeData = getChallenge(expectedChallenge);
  if (!challengeData) return res.status(400).json({ error: 'Invalid or expired challenge' });

  try {
    const credentialID = body.id; 
    const bufferID = Buffer.from(credentialID, 'base64url');
    
    const credResult = await db.query('SELECT * FROM webauthn_credentials WHERE credential_id = $1', [bufferID]);
    
    if (credResult.rows.length === 0) {
        return res.status(400).json({ error: 'Credential not found' });
    }
    
    const credential = credResult.rows[0];
    const userId = credential.user_id;
    
    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    
    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
          credentialPublicKey: credential.public_key,
          credentialID: credential.credential_id,
          counter: credential.counter
      },
      requireUserVerification: true,
    });
    
    if (verification.verified) {
        const { authenticationInfo } = verification;
        const { newCounter } = authenticationInfo;
        
        await db.query('UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2', [newCounter, credential.id]);
        
        const token = generateToken({
            userId: user.id,
            role: user.role || 'user'
        });
        
        removeChallenge(expectedChallenge);
        res.json({ verified: true, token, userId: user.id });
    } else {
        res.status(400).json({ verified: false, error: 'Verification failed' });
    }

  } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
  }
};

exports.getUserCredentials = async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await db.query('SELECT id, name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1', [userId]);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.deleteCredential = async (req, res) => {
    const userId = req.user.id;
    const credId = req.params.id;
    try {
        await db.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [credId, userId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
