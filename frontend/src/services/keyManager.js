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
      
      // Cache the keys
      this.privateKey = keyPair.privateKey;
      
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
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['keys'], 'readwrite');
      const store = transaction.objectStore('keys');
      
      const request = store.put({
        id: KEY_STORAGE_KEY,
        privateKey: privateKeyBase64,
        timestamp: Date.now()
      });
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
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
  async getUserPublicKey(userId) {
    try {
      // Check cache first
      if (this.publicKeyCache.has(userId)) {
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
      const recipientPublicKey = await this.getUserPublicKey(recipientUserId);
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
        console.log('User already has complete key set up');
        return true;
      }
      
      if (hasLocalPrivateKey && !hasServerPublicKey) {
        // We have private key locally but no public key on server - repair needed
        console.log('Private key exists locally but public key missing on server, repairing...');
        const result = await this.repairKeys();
        console.log('Keys repaired successfully');
        return result;
      }
      
      if (!hasLocalPrivateKey && hasServerPublicKey) {
        // We have server key but no local private key - generate fresh keys
        console.warn('Public key exists on server but no private key locally - generating fresh keys');
        const result = await this.generateUserKeys();
        console.log('Fresh keys generated to replace missing private key');
        return result;
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
}

// Create singleton instance
const keyManager = new KeyManager();

export default keyManager;