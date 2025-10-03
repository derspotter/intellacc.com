// frontend/src/services/keyManager.js
// Service for managing user encryption keys and secure storage

import cryptoService from './crypto.js';
import api from './api.js';

const KEY_STORAGE_KEY = 'intellacc_private_key';
const PUBLIC_KEY_CACHE_KEY = 'intellacc_public_keys';

/**
 * Key Manager for handling user encryption keys
 * Stores private keys securely in IndexedDB and caches public keys
 */
class KeyManager {
  constructor() {
    this.privateKey = null;
    this.publicKeyCache = new Map();
    this.dbName = 'intellacc_keys';
    this.dbVersion = 1;
    this.db = null;
  }

  /**
   * Initialize the key manager and IndexedDB
   */
  async initialize() {
    try {
      await this.initDB();
      await this.loadPrivateKey();
      await this.loadPublicKeyCache();
    } catch (error) {
      console.error('Error initializing key manager:', error);
      throw error;
    }
  }

  /**
   * Initialize IndexedDB for secure key storage
   */
  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Create object stores if they don't exist
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys', { keyPath: 'id' });
        }
        
        if (!db.objectStoreNames.contains('publicKeys')) {
          db.createObjectStore('publicKeys', { keyPath: 'userId' });
        }
      };
    });
  }

  /**
   * Generate new key pair for the user
   */
  async generateUserKeys() {
    try {
      const keyPair = await cryptoService.generateKeyPair();
      
      // Export keys
      const publicKeyBase64 = await cryptoService.exportPublicKey(keyPair.publicKey);
      const privateKeyBase64 = await cryptoService.exportPrivateKey(keyPair.privateKey);
      
      // Store private key securely in IndexedDB
      await this.storePrivateKey(privateKeyBase64);
      
      // Store public key on server
      await api.keys.storePublicKey(publicKeyBase64);
      
      // Re-import a non-extractable working key and discard the exportable instance
      const nonExtractable = await cryptoService.importPrivateKey(privateKeyBase64, false);
      this.privateKey = nonExtractable;
      
      return {
        publicKey: publicKeyBase64,
        fingerprint: await cryptoService.generateKeyFingerprint(publicKeyBase64)
      };
    } catch (error) {
      console.error('Error generating user keys:', error);
      throw error;
    }
  }

  /**
   * Store private key in IndexedDB
   */
  async storePrivateKey(privateKeyBase64) {
    try {
      // If we have a passphrase, encrypt before storing
      const pass = this._passphrase || null;
      let record;
      if (pass) {
        const salt = window.crypto.getRandomValues(new Uint8Array(16));
        const aesKey = await cryptoService.deriveKey(pass, salt);
        const enc = await cryptoService.encryptData(aesKey, privateKeyBase64);
        record = {
          id: KEY_STORAGE_KEY,
          encryptedPrivateKey: enc.ciphertext,
          salt: cryptoService.bytesToBase64(salt),
          iv: enc.iv,
          timestamp: Date.now()
        };
      } else {
        // Fallback to legacy plaintext storage if no passphrase yet
        record = {
          id: KEY_STORAGE_KEY,
          privateKey: privateKeyBase64,
          timestamp: Date.now()
        };
      }
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(['keys'], 'readwrite');
        const store = transaction.objectStore('keys');
        const request = store.put(record);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (e) {
      throw e;
    }
  }

  /**
   * Load private key from IndexedDB
   */
  async loadPrivateKey() {
    try {
      const keyData = await this.getFromDB('keys', KEY_STORAGE_KEY);
      
      if (keyData && keyData.privateKey) {
        this.privateKey = await cryptoService.importPrivateKey(keyData.privateKey);
        console.log('Private key loaded from secure storage');
        return true;
      }

      // New encrypted storage format
      if (keyData && keyData.encryptedPrivateKey && keyData.salt && keyData.iv) {
        if (!this._passphrase) {
          console.warn('Encrypted private key present but no passphrase provided. Call keyManager.unlock(passphrase).');
          return false;
        }
        try {
          const salt = cryptoService.base64ToBytes(keyData.salt);
          const aesKey = await cryptoService.deriveKey(this._passphrase, salt);
          const plain = await cryptoService.decryptData(aesKey, keyData.iv, keyData.encryptedPrivateKey);
          this.privateKey = await cryptoService.importPrivateKey(plain);
          console.log('Private key decrypted and loaded');
          return true;
        } catch (e) {
          console.error('Failed to decrypt private key with provided passphrase');
          return false;
        }
      }
      
      console.log('No private key found in storage');
      return false;
    } catch (error) {
      console.error('Error loading private key:', error);
      return false;
    }
  }

  /**
   * Get data from IndexedDB
   */
  async getFromDB(storeName, key) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  /**
   * Check if user has keys set up (both local private key and server public key)
   */
  async hasKeys() {
    // Check if we have local private key
    if (!this.privateKey) {
      return false;
    }
    
    // Check if we have public key on server
    try {
      const serverKey = await this.getMyPublicKey();
      return serverKey !== null;
    } catch (error) {
      console.error('Error checking server public key:', error);
      return false;
    }
  }

  /**
   * Get user's public key from server or cache
   */
  async getUserPublicKey(userId, options = {}) {
    try {
      const forceRefresh = !!options.forceRefresh;
      // Check cache first
      if (!forceRefresh && this.publicKeyCache.has(userId)) {
        const cached = this.publicKeyCache.get(userId);
        // Check if cache is still fresh (1 hour)
        if (Date.now() - cached.timestamp < 3600000) {
          return cached.publicKey;
        }
      }

      // Fetch from server
      const response = await api.keys.getUserPublicKey(userId);
      const publicKey = response.key.publicKey;
      
      // Cache the key
      this.publicKeyCache.set(userId, {
        publicKey: publicKey,
        fingerprint: response.key.fingerprint,
        timestamp: Date.now()
      });
      
      // Store in IndexedDB for persistence
      await this.cachePublicKey(userId, publicKey, response.key.fingerprint);
      
      return publicKey;
    } catch (error) {
      console.error('Error getting user public key:', error);
      throw error;
    }
  }

  /**
   * Get multiple user public keys
   */
  async getMultiplePublicKeys(userIds) {
    try {
      // Check which keys we need to fetch
      const uncachedIds = [];
      const result = {};
      
      for (const userId of userIds) {
        if (this.publicKeyCache.has(userId)) {
          const cached = this.publicKeyCache.get(userId);
          if (Date.now() - cached.timestamp < 3600000) {
            result[userId] = cached.publicKey;
            continue;
          }
        }
        uncachedIds.push(userId);
      }
      
      // Fetch uncached keys
      if (uncachedIds.length > 0) {
        const response = await api.post('/api/keys/batch', { userIds: uncachedIds });
        
        for (const keyData of response.keys) {
          const userId = keyData.userId;
          result[userId] = keyData.publicKey;
          
          // Cache the key
          this.publicKeyCache.set(userId, {
            publicKey: keyData.publicKey,
            fingerprint: keyData.fingerprint,
            timestamp: Date.now()
          });
          
          // Store in IndexedDB
          await this.cachePublicKey(userId, keyData.publicKey, keyData.fingerprint);
        }
      }
      
      return result;
    } catch (error) {
      console.error('Error getting multiple public keys:', error);
      throw error;
    }
  }

  /**
   * Cache public key in IndexedDB
   */
  async cachePublicKey(userId, publicKey, fingerprint) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['publicKeys'], 'readwrite');
      const store = transaction.objectStore('publicKeys');
      
      const request = store.put({
        userId: userId,
        publicKey: publicKey,
        fingerprint: fingerprint,
        timestamp: Date.now()
      });
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Load public key cache from IndexedDB
   */
  async loadPublicKeyCache() {
    try {
      const transaction = this.db.transaction(['publicKeys'], 'readonly');
      const store = transaction.objectStore('publicKeys');
      const request = store.getAll();
      
      return new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const keys = request.result;
          
          for (const keyData of keys) {
            // Only cache if less than 24 hours old
            if (Date.now() - keyData.timestamp < 86400000) {
              this.publicKeyCache.set(keyData.userId, {
                publicKey: keyData.publicKey,
                fingerprint: keyData.fingerprint,
                timestamp: keyData.timestamp
              });
            }
          }
          
          console.log(`Loaded ${this.publicKeyCache.size} public keys from cache`);
          resolve();
        };
      });
    } catch (error) {
      console.error('Error loading public key cache:', error);
    }
  }

  /**
   * Encrypt message for recipient
   */
  async encryptMessage(message, recipientUserId) {
    try {
      // Always refresh recipient public key to avoid using stale keys after rotations
      const recipientPublicKey = await this.getUserPublicKey(recipientUserId, { forceRefresh: true });
      const myPublicKey = await this.getMyPublicKey();
      
      if (!myPublicKey || !myPublicKey.publicKey) {
        // Fallback to old method if sender's public key not available
        return await cryptoService.encryptMessageForRecipient(message, recipientPublicKey);
      }
      
      // Use new method that encrypts for both users
      return await cryptoService.encryptMessageForBothUsers(message, recipientPublicKey, myPublicKey.publicKey);
    } catch (error) {
      console.error('Error encrypting message:', error);
      throw error;
    }
  }

  /**
   * Decrypt message from sender
   */
  async decryptMessage(encryptedContent, encryptedSessionKey) {
    try {
      if (!this.privateKey) {
        // Attempt lazy load in case initialization hasn't completed yet
        try {
          await this.loadPrivateKey();
        } catch {}
      }
      if (!this.privateKey) {
        throw new Error('No private key available for decryption');
      }
      
      return await cryptoService.decryptMessageFromSender(
        encryptedContent,
        encryptedSessionKey,
        this.privateKey
      );
    } catch (error) {
      console.error('Error decrypting message:', error);
      throw error;
    }
  }


  /**
   * Get key fingerprint for verification
   */
  async getKeyFingerprint(publicKeyBase64) {
    return await cryptoService.generateKeyFingerprint(publicKeyBase64);
  }

  /**
   * Clear all keys (logout)
   */
  async clearKeys() {
    try {
      this.privateKey = null;
      this.publicKeyCache.clear();
      
      // Clear IndexedDB
      await this.clearDB();
      
      console.log('All keys cleared');
    } catch (error) {
      console.error('Error clearing keys:', error);
    }
  }

  /**
   * Lock keys in memory
   */
  lockKeys() {
    this.privateKey = null;
    try { document.dispatchEvent(new CustomEvent('keys-locked')); } catch {}
  }

  /**
   * Encrypt current in-memory private key at rest with passphrase
   */
  async encryptAtRest(passphrase) {
    this._passphrase = passphrase;
    // Read existing record; if plaintext is present, encrypt and replace
    const existing = await this.getFromDB('keys', KEY_STORAGE_KEY);
    if (existing && existing.encryptedPrivateKey && existing.salt && existing.iv) {
      // Already encrypted-at-rest; nothing to do
      return true;
    }
    let privateKeyBase64 = null;
    if (existing && existing.privateKey) {
      privateKeyBase64 = existing.privateKey;
    } else if (this.privateKey) {
      // As a fallback, try to export the in-memory key (may fail if non-extractable)
      try {
        privateKeyBase64 = await cryptoService.exportPrivateKey(this.privateKey);
      } catch (e) {
        throw new Error('No plaintext key available to encrypt at rest');
      }
    } else {
      throw new Error('No key available to encrypt at rest');
    }

    // Delegate encryption to a dedicated worker to reduce exposure
    const record = await this.wrapInWorker(privateKeyBase64, passphrase);
    await this.saveEncryptedRecord(record);
    return true;
  }

  /**
  * Wrap/encrypt base64 private key in a Worker
  */
  wrapInWorker(privateKeyBase64, passphrase) {
   return new Promise((resolve, reject) => {
   try {
     const worker = new Worker(new URL('../workers/keyWrapWorker.js', import.meta.url), { type: 'module' });
     const handleMessage = (e) => {
       const { ok, record, error } = e.data || {};
     worker.removeEventListener('message', handleMessage);
       worker.terminate();
       if (error) return reject(new Error(error));
         if (!ok || !record) return reject(new Error('Worker failed to wrap key'));
           resolve(record);
       };
      worker.addEventListener('message', handleMessage);
      worker.postMessage({ action: 'encryptAtRest', privateKeyBase64, passphrase });
      } catch (err) {
        reject(err);
      }
    });
  }

  async saveEncryptedRecord(record) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['keys'], 'readwrite');
      const store = transaction.objectStore('keys');
      const request = store.put({
        id: KEY_STORAGE_KEY,
        encryptedPrivateKey: record.encryptedPrivateKey,
        salt: record.salt,
        iv: record.iv,
        timestamp: Date.now()
      });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
    * Unlock by providing passphrase to decrypt key at rest
    * @param {string} passphrase
    */
  async unlock(passphrase) {
    this._passphrase = passphrase;
    // Try load/decrypt
    const ok = await this.loadPrivateKey();
    if (ok) {
      try { document.dispatchEvent(new CustomEvent('keys-unlocked')); } catch {}
    }
    return ok;
  }

  /**
    * Clear IndexedDB
    */
  async clearDB() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['keys', 'publicKeys'], 'readwrite');
      
      const clearKeys = transaction.objectStore('keys').clear();
      const clearPublicKeys = transaction.objectStore('publicKeys').clear();
      
      let completed = 0;
      const complete = () => {
        completed++;
        if (completed === 2) resolve();
      };
      
      clearKeys.onsuccess = complete;
      clearPublicKeys.onsuccess = complete;
      
      clearKeys.onerror = reject;
      clearPublicKeys.onerror = reject;
    });
  }

  /**
   * Get my public key from server
   */
  async getMyPublicKey() {
    try {
      const response = await api.keys.getMyPublicKey();
      return response.key;
    } catch (error) {
      if (error.status === 404 || error.response?.status === 404) {
        return null; // No key found
      }
      throw error;
    }
  }

  /**
   * Check if a repair has been requested/needed
   */
  needsRepairFlag() {
    try { return localStorage.getItem('intellacc_keys_needs_repair') === 'true'; } catch { return false; }
  }

  /**
   * Repair keys by regenerating and uploading public key to server
   * Note: Since we can't derive public key from private key with Web Crypto API,
   * we'll generate a fresh key pair and replace both keys
   */
  async repairKeys() {
    try {
      console.log('Repairing keys: generating fresh key pair...');
      
      // Generate new key pair
      const keyPair = await cryptoService.generateKeyPair();
      
      // Export keys
      const publicKeyBase64 = await cryptoService.exportPublicKey(keyPair.publicKey);
      const privateKeyBase64 = await cryptoService.exportPrivateKey(keyPair.privateKey);
      
      // Store private key locally (replace old one)
      await this.storePrivateKey(privateKeyBase64);
      
      // Store public key on server
      await api.keys.storePublicKey(publicKeyBase64);
      
      // Update cached private key
      this.privateKey = keyPair.privateKey;
      
      console.log('Keys repaired successfully: fresh key pair generated and stored');
      
      return {
        publicKey: publicKeyBase64,
        fingerprint: await cryptoService.generateKeyFingerprint(publicKeyBase64)
      };
    } catch (error) {
      console.error('Error repairing keys:', error);
      throw error;
    }
  }

  /**
   * Ensure user has keys (generate if needed)
   */
  async ensureKeys() {
    try {
      console.log('Checking if user has keys...');
      
      // Check if we have both local private key and server public key
      const hasLocalPrivateKey = this.privateKey !== null;
      const serverKey = await this.getMyPublicKey();
      const hasServerPublicKey = serverKey !== null;
      
      if (hasLocalPrivateKey && hasServerPublicKey) {
        // Both sides present; validate they actually match by doing a quick
        // encrypt/decrypt round-trip against our own server-stored public key.
        let valid = false;
        try {
          const test = await cryptoService.encryptMessageForRecipient(
            'ping',
            serverKey.publicKey
          );
          const msg = await cryptoService.decryptMessageFromSender(
            test.encryptedContent,
            test.encryptedSessionKey,
            this.privateKey
          );
          valid = msg === 'ping';
        } catch (e) {
          valid = false;
        }

        if (valid) {
          console.log('User already has complete key set up');
          return true;
        }

        // If not valid, auto-repair by generating a fresh keypair and
        // uploading the new public key so messaging works seamlessly.
        console.warn('Key mismatch detected between local private key and server public key. Auto-repairing...');
        const result = await this.repairKeys();
        console.log('Auto-repair complete');
        return result;
      }
      
      if (hasLocalPrivateKey && !hasServerPublicKey) {
        // We have private key locally but no public key on server - repair needed
        console.log('Private key exists locally but public key missing on server, repairing...');
        const result = await this.repairKeys();
        console.log('Keys repaired successfully');
        return result;
      }
      
      if (!hasLocalPrivateKey && hasServerPublicKey) {
        // We have server key but no local private key. Do NOT overwrite the server key automatically,
        // to avoid breaking other devices that can still decrypt with the existing key.
        console.warn('Public key exists on server but no local private key. Skipping auto-repair to avoid key mismatch.');
        try { localStorage.setItem('intellacc_keys_needs_repair', 'true'); } catch {}
        return { needsRepair: true };
      }
      
      // No keys found anywhere - generate new ones
      console.log('No keys found, generating new encryption keys...');
      const result = await this.generateUserKeys();
      console.log('Keys generated successfully');
      return result;
      
    } catch (error) {
      console.error('Error ensuring keys:', error);
      throw error;
    }
  }

  /**
   * Clear public key cache for a specific user
   */
  clearUserPublicKeyCache(userId) {
    this.publicKeyCache.delete(userId);
    
    // Also remove from IndexedDB
    if (this.db) {
      const transaction = this.db.transaction(['publicKeys'], 'readwrite');
      const store = transaction.objectStore('publicKeys');
      store.delete(userId);
    }
    
    console.log(`Cleared public key cache for user ${userId}`);
  }

  /**
   * Clear all public key cache
   */
  clearAllPublicKeyCache() {
  this.publicKeyCache.clear();
  
  // Clear IndexedDB cache
  if (this.db) {
  const transaction = this.db.transaction(['publicKeys'], 'readwrite');
  const store = transaction.objectStore('publicKeys');
  store.clear();
  }
  
  console.log('Cleared all public key cache');
  }

   /**
   * Whether the private key is currently unlocked in memory
   */
   isUnlocked() {
    return !!this.privateKey;
  }
}
 
// Create singleton instance
const keyManager = new KeyManager();
 
export default keyManager;
