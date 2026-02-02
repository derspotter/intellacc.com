import { createStore } from "solid-js/store";
import io from "socket.io-client";
import { getToken } from "./tokenService";

const [state, setState] = createStore({
    connected: false,
    messages: [],
    lastMarketUpdate: null,
    lastMarketUpdate: null,
    lastNotification: null,
    latency: 0 // ms
});

let socket;

export const useSocket = () => {
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
            console.log('Socket connected');
            setState('connected', true);
        });

        socket.on('disconnect', () => {
            console.log('Socket disconnected');
            setState('connected', false);
        });

        socket.on('marketUpdate', (data) => {
            setState('lastMarketUpdate', data);
        });

        socket.on('notification', (data) => {
            setState('lastNotification', data);
        });

        socket.on('chat:message', (data) => {
            console.log('[Socket] Received message:', data);
            setState('messages', (prev) => [...prev, data]);
        });

        // Latency Loop
        const pingInterval = setInterval(() => {
            if (socket && socket.connected) {
                const start = Date.now();
                socket.volatile.emit('ping', () => {
                    const latency = Date.now() - start;
                    setState('latency', latency);
                });
            }
        }, 2000); // Ping every 2s

        socket.on('disconnect', () => {
            console.log('Socket disconnected');
            setState('connected', false);
            clearInterval(pingInterval);
            // Duplicate disconnect handler inside connect is redundant/confusing, removing it.
            // We already have a top-level disconnect handler below.
        });
    };

    const disconnect = () => {
        if (socket) {
            socket.disconnect();
            socket = null;
            setState('connected', false);
        }
    };

    const sendMessage = (content) => {
        if (socket && socket.connected) {
            // TODO: E2EE Encryption here before emit
            const payload = {
                id: Date.now(),
                content, // plaintext for dev/debug
                timestamp: new Date().toISOString(),
                sender: getToken() ? 'me' : 'anon'
            };
            // Optimistic update
            // setState('messages', (prev) => [...prev, payload]); 
            socket.emit('chat:message', payload);
        }
    };

    return { state, connect, disconnect, sendMessage, socket };
};
