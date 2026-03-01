// frontend/src/services/messaging.js
// MLS E2EE Messaging Service - All legacy code removed

import socketService from './socket.js';
import messagingStore from '../stores/messagingStore.js';
import coreCryptoClient from '@shared/mls/coreCryptoClient.js';

/**
 * MLS Messaging service for end-to-end encrypted messaging
 */
class MessagingService {
    constructor() {
        this.setupSocketHandlers();
    }

    /**
     * Setup Socket.io handlers for real-time MLS messaging
     */
    setupSocketHandlers() {
        // MLS message handlers are set up in coreCryptoClient
        // This just handles the connection state
        socketService.on('connect', () => {
            const userData = this.getUserData();
            if (userData?.userId) {
                console.log('[Messaging] Socket connected, joining MLS room');
                socketService.emit('join-messaging');
            }
        });
    }

    /**
     * Initialize messaging service
     */
    async initialize() {
        try {
            const userData = this.getUserData();
            if (userData?.userId) {
                console.log(`Joining messaging room for user ${userData.userId}`);
                socketService.emit('join-messaging');
            }
            console.log('Messaging service initialized');
        } catch (error) {
            console.error('Error initializing messaging service:', error);
            throw error;
        }
    }

    /**
     * Initialize MLS E2EE for the current user
     */
    async initializeMls() {
        const userData = this.getUserData();
        if (!userData?.userId) {
            console.warn('[MLS] Cannot initialize MLS - no user logged in');
            return false;
        }

        try {
            await coreCryptoClient.ensureMlsBootstrap(String(userData.userId));
            console.log('[MLS] MLS initialized for userId:', userData.userId);

            const processedIds = await coreCryptoClient.syncMessages();
            if (processedIds.length > 0) {
                console.log('[MLS] Processed pending invites/messages:', processedIds.length);
            }

            return true;
        } catch (error) {
            console.error('[MLS] Failed to initialize MLS:', error);
            return false;
        }
    }

    /**
     * Get MLS groups for the current user
     */
    async getMlsGroups() {
        const token = localStorage.getItem('token');
        if (!token) return [];

        try {
            const response = await fetch('/api/mls/groups', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) {
                console.warn('[MLS] Failed to fetch groups:', response.status);
                return [];
            }
            const groups = await response.json();
            console.log('[MLS] Fetched groups:', groups.length);
            return groups;
        } catch (error) {
            console.error('[MLS] Error fetching groups:', error);
            return [];
        }
    }

    /**
     * Create an MLS group
     */
    async createMlsConversation(groupName) {
        const userData = this.getUserData();
        if (!userData) throw new Error('Not logged in');

        const group = await coreCryptoClient.createGroup(groupName);
        console.log('[MLS] Created group:', group);
        return group;
    }

    /**
     * Send an MLS-encrypted message to a group
     */
    async sendMlsMessage(groupId, message) {
        if (!message.trim()) throw new Error('Message cannot be empty');

        const result = await coreCryptoClient.sendMessage(groupId, message);
        console.log('[MLS] Message sent:', result);
        return result;
    }

    /**
     * Fetch and decrypt messages from an MLS group
     */
    async getMlsMessages(groupId, afterId = 0) {
        const messages = await coreCryptoClient.fetchAndDecryptMessages(groupId, afterId);
        console.log('[MLS] Fetched messages:', messages.length);
        return messages;
    }

    /**
     * Register a callback for real-time MLS messages
     */
    onMlsMessage(callback) {
        return coreCryptoClient.onMessage(callback);
    }

    /**
     * Register a callback for new group invites
     */
    onMlsWelcome(callback) {
        return coreCryptoClient.onWelcome(callback);
    }

    /**
     * Get user data from JWT token
     */
    getUserData() {
        try {
            const token = localStorage.getItem('token');
            if (!token) return null;

            const payload = JSON.parse(atob(token.split('.')[1]));
            return { userId: payload.userId };
        } catch (error) {
            return null;
        }
    }

    /**
     * Clear all cached data
     */
    clearCache() {
        messagingStore.clearCache();
    }
}

const messagingService = new MessagingService();
export default messagingService;
