// frontend/src/services/crypto.js
// End-to-end encryption service using Web Crypto API

/**
 * Crypto service for end-to-end encrypted messaging
 * Uses RSA-OAEP for key exchange and AES-GCM for message encryption
 */

const CRYPTO_CONFIG = {
  rsa: {
    name: 'RSA-OAEP',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  },
  aes: {
    name: 'AES-GCM',
    length: 256
  }
};

/**
 * Generate RSA key pair for user
 * @returns {Promise<{publicKey: CryptoKey, privateKey: CryptoKey}>}
 */
async function generateKeyPair() {
  try {
    const keyPair = await window.crypto.subtle.generateKey(
      CRYPTO_CONFIG.rsa,
      true, // extractable
      ['encrypt', 'decrypt']
    );
    
    return keyPair;
  } catch (error) {
    console.error('Error generating key pair:', error);
    throw new Error('Failed to generate encryption keys');
  }
}

/**
 * Export public key to base64 string
 * @param {CryptoKey} publicKey - Public key to export
 * @returns {Promise<string>} Base64 encoded public key
 */
async function exportPublicKey(publicKey) {
  try {
    const exported = await window.crypto.subtle.exportKey('spki', publicKey);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    return base64;
  } catch (error) {
    console.error('Error exporting public key:', error);
    throw new Error('Failed to export public key');
  }
}

/**
 * Import public key from base64 string
 * @param {string} base64Key - Base64 encoded public key
 * @returns {Promise<CryptoKey>} Imported public key
 */
async function importPublicKey(base64Key) {
  try {
    const binaryString = atob(base64Key);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const publicKey = await window.crypto.subtle.importKey(
      'spki',
      bytes.buffer,
      CRYPTO_CONFIG.rsa,
      false, // not extractable
      ['encrypt']
    );
    
    return publicKey;
  } catch (error) {
    console.error('Error importing public key:', error);
    throw new Error('Failed to import public key');
  }
}

/**
 * Export private key to base64 string for storage
 * @param {CryptoKey} privateKey - Private key to export
 * @returns {Promise<string>} Base64 encoded private key
 */
async function exportPrivateKey(privateKey) {
  try {
    const exported = await window.crypto.subtle.exportKey('pkcs8', privateKey);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    return base64;
  } catch (error) {
    console.error('Error exporting private key:', error);
    throw new Error('Failed to export private key');
  }
}

/**
 * Import private key from base64 string
 * @param {string} base64Key - Base64 encoded private key
 * @returns {Promise<CryptoKey>} Imported private key
 */
async function importPrivateKey(base64Key) {
  try {
    const binaryString = atob(base64Key);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const privateKey = await window.crypto.subtle.importKey(
      'pkcs8',
      bytes.buffer,
      CRYPTO_CONFIG.rsa,
      false, // not extractable
      ['decrypt']
    );
    
    return privateKey;
  } catch (error) {
    console.error('Error importing private key:', error);
    throw new Error('Failed to import private key');
  }
}

/**
 * Generate AES key for message encryption
 * @returns {Promise<CryptoKey>} AES key
 */
async function generateSessionKey() {
  try {
    const key = await window.crypto.subtle.generateKey(
      CRYPTO_CONFIG.aes,
      true, // extractable
      ['encrypt', 'decrypt']
    );
    
    return key;
  } catch (error) {
    console.error('Error generating session key:', error);
    throw new Error('Failed to generate session key');
  }
}

/**
 * Export AES key to raw bytes
 * @param {CryptoKey} sessionKey - AES key to export
 * @returns {Promise<Uint8Array>} Raw key bytes
 */
async function exportSessionKey(sessionKey) {
  try {
    const exported = await window.crypto.subtle.exportKey('raw', sessionKey);
    return new Uint8Array(exported);
  } catch (error) {
    console.error('Error exporting session key:', error);
    throw new Error('Failed to export session key');
  }
}

/**
 * Import AES key from raw bytes
 * @param {Uint8Array} keyBytes - Raw key bytes
 * @returns {Promise<CryptoKey>} Imported AES key
 */
async function importSessionKey(keyBytes) {
  try {
    const key = await window.crypto.subtle.importKey(
      'raw',
      keyBytes.buffer,
      CRYPTO_CONFIG.aes,
      false, // not extractable
      ['encrypt', 'decrypt']
    );
    
    return key;
  } catch (error) {
    console.error('Error importing session key:', error);
    throw new Error('Failed to import session key');
  }
}

/**
 * Encrypt data with RSA public key
 * @param {CryptoKey} publicKey - Recipient's public key
 * @param {Uint8Array} data - Data to encrypt
 * @returns {Promise<Uint8Array>} Encrypted data
 */
async function encryptWithRSA(publicKey, data) {
  try {
    const encrypted = await window.crypto.subtle.encrypt(
      CRYPTO_CONFIG.rsa,
      publicKey,
      data
    );
    
    return new Uint8Array(encrypted);
  } catch (error) {
    console.error('Error encrypting with RSA:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt data with RSA private key
 * @param {CryptoKey} privateKey - User's private key
 * @param {Uint8Array} encryptedData - Data to decrypt
 * @returns {Promise<Uint8Array>} Decrypted data
 */
async function decryptWithRSA(privateKey, encryptedData) {
  try {
    const decrypted = await window.crypto.subtle.decrypt(
      CRYPTO_CONFIG.rsa,
      privateKey,
      encryptedData
    );
    
    return new Uint8Array(decrypted);
  } catch (error) {
    console.error('Error decrypting with RSA:', error);
    throw new Error('Failed to decrypt data');
  }
}

/**
 * Encrypt message with AES session key
 * @param {CryptoKey} sessionKey - AES session key
 * @param {string} message - Message to encrypt
 * @returns {Promise<{encrypted: Uint8Array, iv: Uint8Array}>} Encrypted message and IV
 */
async function encryptMessage(sessionKey, message) {
  try {
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    
    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      sessionKey,
      data
    );
    
    return {
      encrypted: new Uint8Array(encrypted),
      iv: iv
    };
  } catch (error) {
    console.error('Error encrypting message:', error);
    throw new Error('Failed to encrypt message');
  }
}

/**
 * Decrypt message with AES session key
 * @param {CryptoKey} sessionKey - AES session key
 * @param {Uint8Array} encryptedData - Encrypted message
 * @param {Uint8Array} iv - Initialization vector
 * @returns {Promise<string>} Decrypted message
 */
async function decryptMessage(sessionKey, encryptedData, iv) {
  try {
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      sessionKey,
      encryptedData
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    console.error('Error decrypting message:', error);
    throw new Error('Failed to decrypt message');
  }
}

/**
 * Generate SHA-256 hash of data
 * @param {string} data - Data to hash
 * @returns {Promise<string>} Hex encoded hash
 */
async function generateHash(data) {
  try {
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', dataBytes);
    const hashArray = new Uint8Array(hashBuffer);
    const hashHex = Array.from(hashArray)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    return hashHex;
  } catch (error) {
    console.error('Error generating hash:', error);
    throw new Error('Failed to generate hash');
  }
}

/**
 * Generate fingerprint for public key
 * @param {string} publicKeyBase64 - Base64 encoded public key
 * @returns {Promise<string>} Hex encoded fingerprint
 */
async function generateKeyFingerprint(publicKeyBase64) {
  return await generateHash(publicKeyBase64);
}

/**
 * Convert Uint8Array to base64 string
 * @param {Uint8Array} bytes - Bytes to convert
 * @returns {string} Base64 string
 */
function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Convert base64 string to Uint8Array
 * @param {string} base64 - Base64 string to convert
 * @returns {Uint8Array} Bytes
 */
function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * High-level function to encrypt a message for a recipient
 * @param {string} message - Message to encrypt
 * @param {string} recipientPublicKeyBase64 - Recipient's public key (base64)
 * @returns {Promise<{encryptedContent: string, encryptedSessionKey: string, contentHash: string}>}
 */
async function encryptMessageForRecipient(message, recipientPublicKeyBase64) {
  try {
    // Generate session key for this message
    const sessionKey = await generateSessionKey();
    
    // Encrypt the message with the session key
    const { encrypted, iv } = await encryptMessage(sessionKey, message);
    
    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv);
    combined.set(encrypted, iv.length);
    
    // Import recipient's public key
    const recipientPublicKey = await importPublicKey(recipientPublicKeyBase64);
    
    // Export session key and encrypt it with recipient's public key
    const sessionKeyBytes = await exportSessionKey(sessionKey);
    const encryptedSessionKey = await encryptWithRSA(recipientPublicKey, sessionKeyBytes);
    
    // Generate content hash for integrity
    const contentHash = await generateHash(message);
    
    return {
      encryptedContent: bytesToBase64(combined),
      encryptedSessionKey: bytesToBase64(encryptedSessionKey),
      contentHash: contentHash
    };
  } catch (error) {
    console.error('Error encrypting message for recipient:', error);
    throw error;
  }
}

/**
 * Encrypt message for both sender and recipient
 * @param {string} message - The message to encrypt
 * @param {string} recipientPublicKeyBase64 - Recipient's public key in Base64
 * @param {string} senderPublicKeyBase64 - Sender's public key in Base64
 * @returns {Promise<Object>} Encrypted message data with session keys for both users
 */
async function encryptMessageForBothUsers(message, recipientPublicKeyBase64, senderPublicKeyBase64) {
  try {
    // Generate session key for this message
    const sessionKey = await generateSessionKey();
    
    // Encrypt the message with the session key
    const { encrypted, iv } = await encryptMessage(sessionKey, message);
    
    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv);
    combined.set(encrypted, iv.length);
    
    // Import both public keys
    const recipientPublicKey = await importPublicKey(recipientPublicKeyBase64);
    const senderPublicKey = await importPublicKey(senderPublicKeyBase64);
    
    // Export session key
    const sessionKeyBytes = await exportSessionKey(sessionKey);
    
    // Encrypt session key for both users
    const encryptedSessionKeyRecipient = await encryptWithRSA(recipientPublicKey, sessionKeyBytes);
    const encryptedSessionKeySender = await encryptWithRSA(senderPublicKey, sessionKeyBytes);
    
    // Generate content hash for integrity
    const contentHash = await generateHash(message);
    
    return {
      encryptedContent: bytesToBase64(combined),
      encryptedSessionKey: bytesToBase64(encryptedSessionKeyRecipient),
      senderSessionKey: bytesToBase64(encryptedSessionKeySender),
      contentHash: contentHash
    };
  } catch (error) {
    console.error('Error encrypting message for both users:', error);
    throw error;
  }
}

/**
 * High-level function to decrypt a message
 * @param {string} encryptedContentBase64 - Encrypted message (base64)
 * @param {string} encryptedSessionKeyBase64 - Encrypted session key (base64)
 * @param {CryptoKey} privateKey - User's private key
 * @returns {Promise<string>} Decrypted message
 */
async function decryptMessageFromSender(encryptedContentBase64, encryptedSessionKeyBase64, privateKey) {
  try {
    // Decrypt session key with private key
    const encryptedSessionKey = base64ToBytes(encryptedSessionKeyBase64);
    const sessionKeyBytes = await decryptWithRSA(privateKey, encryptedSessionKey);
    const sessionKey = await importSessionKey(sessionKeyBytes);
    
    // Extract IV and encrypted data
    const combined = base64ToBytes(encryptedContentBase64);
    const iv = combined.slice(0, 12); // First 12 bytes are IV
    const encrypted = combined.slice(12); // Rest is encrypted data
    
    // Decrypt the message
    const message = await decryptMessage(sessionKey, encrypted, iv);
    
    return message;
  } catch (error) {
    console.error('Error decrypting message from sender:', error);
    throw error;
  }
}

export default {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportPrivateKey,
  importPrivateKey,
  generateSessionKey,
  encryptMessage,
  decryptMessage,
  generateHash,
  generateKeyFingerprint,
  encryptMessageForRecipient,
  decryptMessageFromSender,
  bytesToBase64,
  base64ToBytes,
  encryptMessageForBothUsers
};