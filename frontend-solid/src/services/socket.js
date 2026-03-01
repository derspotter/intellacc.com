import { createStore } from "solid-js/store";
import io from "socket.io-client";
import { getToken, clearToken } from "./tokenService";
import { feedStore } from "../store/feedStore";
import { marketStore } from "../store/marketStore";

const [state, setState] = createStore({
    connected: false,
    lastNotification: null,
    notifications: []
});

let socket = null;

const MAX_NOTIFICATIONS = 50;

// Simple pub/sub for MLS socket events (ChatPanel subscribes here).
const mlsMessageSubscribers = new Set();
const mlsWelcomeSubscribers = new Set();

export const onMlsMessage = (handler) => {
    if (typeof handler !== 'function') return () => {};
    mlsMessageSubscribers.add(handler);
    return () => mlsMessageSubscribers.delete(handler);
};

export const onMlsWelcome = (handler) => {
    if (typeof handler !== 'function') return () => {};
    mlsWelcomeSubscribers.add(handler);
    return () => mlsWelcomeSubscribers.delete(handler);
};

export const registerSocketEventHandler = (eventName, handler) => {
    if (typeof handler !== 'function') return () => {};
    if (eventName === 'mls-message') return onMlsMessage(handler);
    if (eventName === 'mls-welcome') return onMlsWelcome(handler);
    return () => {};
};

const emitToSubscribers = (subs, payload) => {
    for (const fn of subs) {
        try {
            fn(payload);
        } catch (e) {
            console.warn('[Socket] MLS subscriber error:', e);
        }
    }
};

const normalizeNotificationText = (data) => {
    if (typeof data === 'string') return data;
    if (data?.text != null) return String(data.text);
    if (data?.message != null) return String(data.message);
    if (data?.title != null) return String(data.title);
    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
};

const isAuthConnectError = (err) => {
    const msgRaw = err?.message ?? err?.data?.message ?? err?.description ?? '';
    const msg = String(msgRaw).toLowerCase();
    const status = err?.status ?? err?.statusCode ?? err?.data?.status ?? err?.data?.statusCode;
    const code = err?.code ?? err?.data?.code;

    if (status === 401 || code === 401) return true;
    return msg.includes('unauthorized') || msg.includes('authentication') || msg.includes('auth');
};

const connect = () => {
    if (socket?.connected) return;

    const token = getToken();
    const socketUrl = window.location.origin;

    socket = io(socketUrl, {
        path: '/socket.io',
        auth: token ? { token } : undefined,
        transports: ['websocket'],
        reconnection: true
    });

    socket.on('connect', () => {
        console.log('[Socket] connected');
        setState('connected', true);
        socket.emit('join-predictions');
        socket.emit('authenticate');
        socket.emit('join-mls');
    });

    socket.on('disconnect', () => {
        console.log('[Socket] disconnected');
        setState('connected', false);
    });

    socket.on('connect_error', (err) => {
        console.warn('[Socket] connect_error', err?.message || err);
        setState('connected', false);

        if (isAuthConnectError(err)) {
            try {
                socket?.disconnect();
            } catch {}
            socket = null;
            clearToken(); // forces re-login flow
        }
    });

    socket.on('new_post', (post) => {
        feedStore.addPost(post);
    });

    socket.on('new_comment', (comment) => {
        feedStore.addComment(comment);
    });

    socket.on('post_updated', (post) => {
        feedStore.updatePost(post);
    });

    socket.on('marketUpdate', (update) => {
        marketStore.applyMarketUpdate(update);
    });

    socket.on('notification', (data) => {
        const text = normalizeNotificationText(data);
        const entry = { ts: Date.now(), text, raw: data };

        setState('lastNotification', text);
        setState('notifications', (prev) => {
            const next = [...(prev || []), entry];
            return next.length > MAX_NOTIFICATIONS ? next.slice(-MAX_NOTIFICATIONS) : next;
        });
    });

    // MLS realtime hints: "new messages available" + "new welcome available".
    socket.on('mls-message', (payload) => {
        emitToSubscribers(mlsMessageSubscribers, payload);
    });

    socket.on('mls-welcome', (payload) => {
        emitToSubscribers(mlsWelcomeSubscribers, payload);
    });
};

const disconnect = () => {
    if (socket) {
        socket.disconnect();
        socket = null;
        setState('connected', false);
    }
};

const getSocket = () => socket;

export const useSocket = () => ({ state, connect, disconnect, getSocket });
