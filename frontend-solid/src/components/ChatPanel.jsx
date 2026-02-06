import { createSignal, Show, For, createEffect, onCleanup } from "solid-js";
import { Panel } from "./ui/Panel";
import vaultService from "../services/mls/vaultService";
import vaultStore from "../store/vaultStore";
import { userData, getToken } from "../services/tokenService";
import { api } from "../services/api";
import coreCryptoClient from "../services/mls/coreCryptoClient";
import { onMlsMessage, onMlsWelcome } from "../services/socket";

export const ChatPanel = () => {
    const [password, setPassword] = createSignal("");
    const [unlocking, setUnlocking] = createSignal(false);
    const [error, setError] = createSignal("");
    const [msgInput, setMsgInput] = createSignal("");

    // Real data state
    const [conversations, setConversations] = createSignal([]);
    const [selectedConversation, setSelectedConversation] = createSignal(null);
    const [messages, setMessages] = createSignal([]);
    const [loadingConvs, setLoadingConvs] = createSignal(false);
    const [unreadCounts, setUnreadCounts] = createSignal({});

    // New DM flow state
    const [showNewDM, setShowNewDM] = createSignal(false);
    const [searchQuery, setSearchQuery] = createSignal("");
    const [searchResults, setSearchResults] = createSignal([]);
    const [searching, setSearching] = createSignal(false);

    const getConversationId = (conv) => String(conv?.group_id || conv?.groupId || conv?.id || '');

    const bumpUnread = (convId) => {
        if (!convId) return;
        setUnreadCounts((prev) => {
            const next = { ...(prev || {}) };
            next[convId] = (next[convId] || 0) + 1;
            return next;
        });
    };

    const clearUnread = (convId) => {
        if (!convId) return;
        setUnreadCounts((prev) => {
            if (!prev || prev[convId] == null) return prev;
            const next = { ...prev };
            delete next[convId];
            return next;
        });
    };

    const hexToBytes = (hex) => {
        if (typeof hex !== 'string') return null;
        let s = hex.trim();
        if (s.startsWith('\\\\x')) s = s.slice(2);
        if (s.startsWith('0x')) s = s.slice(2);
        if (!s || s.length % 2 !== 0) return null;
        if (!/^[0-9a-fA-F]+$/.test(s)) return null;
        const out = new Uint8Array(s.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
        return out;
    };

    const toBytes = (v) => {
        if (v == null) return null;
        if (v instanceof Uint8Array) return v;
        if (Array.isArray(v)) return new Uint8Array(v);
        if (v?.type === 'Buffer' && Array.isArray(v.data)) return new Uint8Array(v.data);
        if (typeof v === 'string') {
            const b = hexToBytes(v);
            return b;
        }
        return null;
    };

    let searchReqId = 0;
    createEffect(() => {
        if (!showNewDM()) return;

        const q = searchQuery().trim();
        if (!q) {
            setSearchResults([]);
            setSearching(false);
            return;
        }

        const reqId = ++searchReqId;
        setSearching(true);

        const t = setTimeout(async () => {
            try {
                const results = await api.usersSearch(q);
                if (reqId !== searchReqId) return;
                setSearchResults(Array.isArray(results) ? results : []);
            } catch (e) {
                if (reqId !== searchReqId) return;
                console.warn("[ChatPanel] usersSearch failed:", e?.message || e);
                setSearchResults([]);
            } finally {
                if (reqId === searchReqId) setSearching(false);
            }
        }, 250);

        onCleanup(() => clearTimeout(t));
    });

    let pendingSyncPromise = null;
    const processPendingQueue = async () => {
        if (pendingSyncPromise) return pendingSyncPromise;
        pendingSyncPromise = (async () => {
            try {
                const pending = await api.mls.getPendingMessages().catch((e) => {
                    console.warn('[ChatPanel] getPendingMessages failed:', e?.message || e);
                    return [];
                });
                if (!Array.isArray(pending) || pending.length === 0) return [];

                const processedIds = [];
                const client = coreCryptoClient?.client || null;
                for (const msg of pending) {
                    const messageId = msg?.id;
                    try {
                        // Best-effort processing to keep MLS state consistent, then ack.
                        const type = msg?.message_type || msg?.content_type;

                        if (type === 'welcome') {
                            const welcomeBytes = toBytes(msg?.data);
                            if (!welcomeBytes) throw new Error('Invalid welcome bytes');
                            client?.process_welcome?.(welcomeBytes, null);
                            await coreCryptoClient?.saveState?.();
                        } else if (type === 'commit') {
                            const groupIdBytes = hexToBytes(String(msg?.group_id || msg?.groupId || ''));
                            const commitBytes = toBytes(msg?.data);
                            if (!groupIdBytes || !commitBytes) throw new Error('Invalid commit payload');
                            client?.process_commit?.(groupIdBytes, commitBytes);
                            client?.merge_staged_commit?.(groupIdBytes);
                            await coreCryptoClient?.saveState?.();
                        } else if (type === 'proposal') {
                            const groupIdBytes = hexToBytes(String(msg?.group_id || msg?.groupId || ''));
                            const proposalBytes = toBytes(msg?.data);
                            if (!groupIdBytes || !proposalBytes) throw new Error('Invalid proposal payload');
                            client?.process_proposal?.(groupIdBytes, proposalBytes);
                            await coreCryptoClient?.saveState?.();
                        } else if (type === 'application') {
                            // Decrypt to validate we can read it; history is fetched via api.mls.getMessages().
                            const groupIdBytes = hexToBytes(String(msg?.group_id || msg?.groupId || ''));
                            const ciphertextBytes = toBytes(msg?.data);
                            if (groupIdBytes && ciphertextBytes) {
                                try {
                                    client?.decrypt_message_with_aad?.(groupIdBytes, ciphertextBytes);
                                } catch (e) {
                                    // Decryption can fail for self-sent messages; don't block ack.
                                }
                            }
                        }

                        if (messageId != null) processedIds.push(messageId);
                    } catch (e) {
                        console.warn('[ChatPanel] Failed processing pending message:', msg?.id, e?.message || e);
                        // If MLS client isn't ready yet (vault unlock race), still ack to prevent infinite backlog.
                        if (!client && messageId != null) processedIds.push(messageId);
                    }
                }

                if (processedIds.length > 0) {
                    await api.mls.ackMessages(processedIds).catch((e) => {
                        console.warn('[ChatPanel] ackMessages failed:', e?.message || e);
                    });
                }
                return processedIds;
            } finally {
                pendingSyncPromise = null;
            }
        })();
        return pendingSyncPromise;
    };

    const refreshConversationMessages = async (convId) => {
        if (!convId) return;
        try {
            const msgs = await api.mls.getMessages(convId, { limit: 50 });
            setMessages(Array.isArray(msgs) ? msgs : []);
        } catch (err) {
            console.error('[ChatPanel] Failed to load messages:', err);
        }
    };

    // Vault unlock: load conversations + drain pending relay queue.
    let wasLocked = true;
    createEffect(() => {
        const locked = vaultStore.state.locked;
        if (wasLocked && !locked) {
            loadConversations();
            processPendingQueue();
        }
        if (!wasLocked && locked) {
            setSelectedConversation(null);
            setMessages([]);
            setUnreadCounts({});
        }
        wasLocked = locked;
    });

    // MLS socket hints (unread badges + auto-refresh when selected).
    const unsubMsg = onMlsMessage((payload) => {
        const groupId = payload?.groupId || payload?.group_id;
        if (!groupId) return;
        const selectedId = getConversationId(selectedConversation());
        if (selectedId && String(selectedId) === String(groupId)) {
            refreshConversationMessages(String(groupId));
            clearUnread(String(groupId));
        } else {
            bumpUnread(String(groupId));
        }
    });
    const unsubWelcome = onMlsWelcome((payload) => {
        const groupId = payload?.groupId || payload?.group_id;
        // Welcome can create a new conversation; refresh list and process pending queue.
        if (!vaultStore.state.locked) {
            loadConversations();
            processPendingQueue();
        }
        if (groupId) bumpUnread(String(groupId));
    });
    onCleanup(() => { try { unsubMsg?.(); } catch {} try { unsubWelcome?.(); } catch {} });

    const loadConversations = async () => {
        setLoadingConvs(true);
        try {
            // Fetch both groups and DMs
            const [groups, dms] = await Promise.all([
                api.mls.getGroups().catch(() => []),
                api.mls.getDirectMessages().catch(() => [])
            ]);

            // Combine and format
            const allConvs = [
                ...groups.map(g => ({ ...g, type: 'group', displayName: g.name || g.group_id })),
                ...dms.map(d => ({ ...d, type: 'dm', displayName: d.other_username || `User ${d.other_user_id}` }))
            ];

            setConversations(allConvs);
            console.log('[ChatPanel] Loaded conversations:', allConvs.length);
            return allConvs;
        } catch (err) {
            console.error('[ChatPanel] Failed to load conversations:', err);
            return [];
        } finally {
            setLoadingConvs(false);
        }
    };

    const selectConversation = async (conv) => {
        setSelectedConversation(conv);
        setMessages([]);

        try {
            const convId = getConversationId(conv);
            clearUnread(convId);
            await refreshConversationMessages(convId);
        } catch (err) {
            console.error('[ChatPanel] Failed to load messages:', err);
        }
    };

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (!msgInput().trim() || !selectedConversation()) return;

        const text = msgInput().trim();
        const convId = getConversationId(selectedConversation());
        if (!convId) return;

        console.log('[ChatPanel] Sending:', text, 'to:', selectedConversation()?.displayName);

        const optimisticId = `opt_${Date.now()}_${Math.random().toString(16).slice(2)}`;

        // Optimistic update (sender device is excluded from relay fanout)
        setMessages(prev => [...prev, {
            id: optimisticId,
            optimistic: true,
            content: text,
            sender: userData()?.username || 'me',
            timestamp: new Date().toISOString()
        }]);

        setMsgInput("");

        try {
            const deviceId = localStorage.getItem('device_id') || localStorage.getItem('device_public_id') || '';
            const token = getToken();

            const res = await fetch('/api/mls/messages/group', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                    ...(deviceId ? { 'x-device-id': deviceId } : {}),
                },
                body: JSON.stringify({ groupId: convId, data: text, deviceId, messageType: 'application' }),
            });

            if (!res.ok) {
                let payload = null;
                try { payload = await res.json(); } catch {}
                const msg = payload?.error || payload?.message || `Send failed (${res.status})`;
                throw new Error(msg);
            }
        } catch (err) {
            console.warn('[ChatPanel] Send failed:', err?.message || err);
            setMessages(prev => (prev || []).filter(m => m?.id !== optimisticId));
        }
    };

    const toggleNewDM = () => {
        const next = !showNewDM();
        setShowNewDM(next);
        setSearchQuery("");
        setSearchResults([]);
        setSearching(false);
        searchReqId++;
    };

    const createDMWithUser = async (targetUserId) => {
        try {
            const res = await api.mls.createDirectMessage(targetUserId);
            const groupId = res?.groupId || res?.group_id || null;

            setShowNewDM(false);
            setSearchQuery("");
            setSearchResults([]);
            setSearching(false);
            searchReqId++;

            const all = await loadConversations();
            const nextConv = (all || []).find(c => String(getConversationId(c)) === String(groupId));
            if (nextConv) await selectConversation(nextConv);
        } catch (e) {
            console.warn('[ChatPanel] createDirectMessage failed:', e?.message || e);
        }
    };

    const handleUnlock = async (e) => {
        e.preventDefault();
        setUnlocking(true);
        setError("");

        try {
            const user = userData();
            const userId = user?.username || (user?.userId ? String(user.userId) : null);
            if (!userId) throw new Error("Wait for login...");

            const success = await vaultService.findAndUnlock(password(), userId);
            if (!success) {
                await vaultService.setupKeystoreWithPassword(password(), userId);
            }
        } catch (err) {
            console.error(err);
            setError(err.message);
        } finally {
            setUnlocking(false);
        }
    };

    return (
        <Panel title="[3] COMMS // E2EE" class="h-full flex flex-col font-mono text-xs">
            <Show when={vaultStore.state.locked}>
                <div class="flex-1 flex flex-col items-center justify-center p-4 bg-bb-bg">
                    <div class="w-full max-w-xs border border-bb-border p-4 bg-bb-panel shadow-glow-red">
                        <form onSubmit={handleUnlock} class="flex flex-col gap-2">
                            <div class="text-[10px] text-bb-muted mb-2 text-center leading-tight">
                                NO LOCAL KEYS FOUND.<br />ENTER PASSWORD TO UNLOCK.
                            </div>
                            <input
                                type="password"
                                value={password()}
                                onInput={(e) => setPassword(e.target.value)}
                                placeholder="Vault Password..."
                                class="bg-black border border-bb-border p-2 text-center text-bb-text focus:border-bb-accent outline-none text-xs"
                                disabled={unlocking()}
                            />
                            <button
                                type="submit"
                                class="bg-bb-accent text-bb-bg font-bold py-1 hover:brightness-110 disabled:opacity-50 text-xs"
                                disabled={unlocking()}
                            >
                                {unlocking() ? 'UNLOCKING...' : '> UNLOCK VAULT'}
                            </button>
                        </form>
                        <Show when={error()}>
                            <div class="text-market-down text-xs mt-2 text-center">{error()}</div>
                        </Show>
                    </div>
                </div>
            </Show>

            <Show when={!vaultStore.state.locked}>
                <div class="flex flex-1 min-h-0 bg-bb-bg text-bb-text font-mono">
                    {/* === LEFT SIDEBAR === */}
                    <div class="w-[200px] min-w-[160px] border-r border-bb-border flex flex-col bg-bb-panel/50">
                        {/* Header */}
                        <div class="bg-bb-panel px-3 py-2 flex items-center justify-between border-b border-bb-border">
                            <span class="font-bold text-xs bg-bb-border px-2 py-0.5 text-bb-accent">IB MANAGER</span>
                            <span class="text-bb-muted text-xs cursor-pointer hover:text-bb-text">[ALERTS]</span>
                        </div>

                        {/* Search/Add Bar */}
                        <div class="bg-bb-accent text-bb-bg flex items-center px-2 py-1 gap-1">
                            <span class="font-bold text-xs">&gt;</span>
                            <input
                                class="flex-1 bg-transparent border-none outline-none text-bb-bg placeholder-bb-bg/70 text-xs font-bold h-6"
                                placeholder={showNewDM() ? "NEW DM: USERNAME/ID..." : "SEARCH..."}
                                value={showNewDM() ? searchQuery() : ""}
                                onInput={(e) => showNewDM() && setSearchQuery(e.target.value)}
                            />
                            <span
                                class={`text-bb-bg font-bold cursor-pointer hover:text-white text-xs ${showNewDM() ? 'underline' : ''}`}
                                onClick={toggleNewDM}
                                title={showNewDM() ? 'Cancel New DM' : 'New DM'}
                            >
                                [+]
                            </span>
                        </div>

                        {/* New DM Search Results */}
                        <Show when={showNewDM()}>
                            <div class="border-b border-bb-border bg-bb-panel/60">
                                <div class="px-3 py-2 text-[10px] text-bb-muted uppercase flex items-center justify-between">
                                    <span>NEW DM</span>
                                    <Show when={searching()}>
                                        <span class="text-bb-muted">SEARCHING...</span>
                                    </Show>
                                </div>

                                <Show when={searchQuery().trim() && !searching() && searchResults().length === 0}>
                                    <div class="px-3 pb-3 text-bb-muted text-[10px]">
                                        NO MATCHES.
                                    </div>
                                </Show>

                                <For each={searchResults()}>
                                    {(u) => (
                                        <div
                                            onClick={() => createDMWithUser(u.id)}
                                            class="px-3 py-2 cursor-pointer border-t border-bb-border/30 hover:bg-bb-border/40 transition-colors flex items-center justify-between"
                                        >
                                            <span class="truncate text-xs text-bb-text">
                                                {(u.username || `USER ${u.id}`).toUpperCase()}
                                            </span>
                                            <span class="text-[10px] text-bb-muted">
                                                #{u.id}
                                            </span>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Show>

                        {/* Conversations List */}
                        <div class="flex-1 overflow-y-auto custom-scrollbar">
                            <div class="text-[10px] text-bb-muted uppercase px-3 py-2 flex items-center gap-1 cursor-pointer hover:text-bb-text select-none border-b border-bb-border/50">
                                <span class="text-[9px]">[v]</span> CHATS
                            </div>

                            <Show when={loadingConvs()}>
                                <div class="text-bb-muted text-center py-2 text-xs">LOADING...</div>
                            </Show>

                            <Show when={!loadingConvs() && conversations().length === 0}>
                                <div class="text-bb-muted text-center py-4 text-xs px-2">
                                    NO ACTIVE CHATS.<br />START NEW.
                                </div>
                            </Show>

                            <For each={conversations()}>
                                {(conv) => (
                                    <div
                                        onClick={() => selectConversation(conv)}
                                        class={`px-3 py-2 cursor-pointer flex justify-between items-center border-b border-bb-border/30 transition-colors ${
                                            (selectedConversation()?.id === conv.id || selectedConversation()?.group_id === conv.group_id)
                                            ? 'bg-bb-border text-bb-accent font-bold'
                                            : 'text-bb-text hover:bg-bb-border/50'
                                            }`}
                                    >
                                        <span class="truncate text-xs">
                                            {conv.type === 'group' ? '[G] ' : ''}{conv.displayName.toUpperCase()}
                                        </span>
                                        <Show when={(unreadCounts()[getConversationId(conv)] || 0) > 0}>
                                            <span class="ml-2 min-w-[18px] h-[18px] px-1 flex items-center justify-center bg-bb-accent text-bb-bg text-[10px] font-bold rounded-sm">
                                                {unreadCounts()[getConversationId(conv)]}
                                            </span>
                                        </Show>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>

                    {/* === RIGHT MAIN CHAT AREA === */}
                    <div class="flex-1 flex flex-col bg-bb-bg min-w-0">
                        {/* Chat Header */}
                        <div class="border-b border-bb-border px-4 py-2 flex items-center gap-3 bg-bb-panel">
                            <Show when={selectedConversation()}>
                                <div class="w-2 h-2 rounded-full bg-market-up shadow-glow-green"></div>
                                <span class="font-bold text-bb-text text-sm uppercase">{selectedConversation()?.displayName}</span>
                            </Show>
                            <Show when={!selectedConversation()}>
                                <span class="text-bb-muted text-xs uppercase">[SELECT CONVERSATION]</span>
                            </Show>
                            <div class="ml-auto flex gap-4 text-bb-muted text-xs font-mono">
                                <span class="cursor-pointer hover:text-bb-accent">[CALL]</span>
                                <span class="cursor-pointer hover:text-bb-accent">[INFO]</span>
                                <span class="cursor-pointer hover:text-bb-accent">[MENU]</span>
                            </div>
                        </div>

                        {/* Messages Area */}
                        <div class="flex-1 overflow-y-auto p-4 font-mono text-xs custom-scrollbar">
                            <Show when={!selectedConversation()}>
                                <div class="text-bb-muted text-center mt-12 text-xs">
                                    // AWAITING SELECTION...
                                </div>
                            </Show>

                            <Show when={selectedConversation() && messages().length === 0}>
                                <div class="text-bb-muted italic text-xs">// NO MESSAGES FOUND. BEGIN TRANSMISSION.</div>
                            </Show>

                            <For each={messages()}>
                                {(msg) => (
                                    <div class="mb-3 hover:bg-bb-border/20 p-1 rounded-sm">
                                        <div class="flex items-baseline gap-2 mb-1">
                                            <span class="text-bb-accent font-bold text-xs">
                                                {(msg.sender || msg.sender_username || 'UNKNOWN').toUpperCase()}
                                            </span>
                                            <span class="text-bb-muted text-[10px]">
                                                {new Date(msg.timestamp || msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                                            </span>
                                        </div>
                                        <div class="text-bb-text text-xs leading-relaxed pl-2 border-l border-bb-border">
                                            <span class="break-words">{msg.content || msg.plaintext || '[ENCRYPTED DATA]'}</span>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>

                        {/* === INPUT AREA === */}
                        <div class="border-t border-bb-border bg-bb-panel p-2 flex flex-col gap-2">
                            <form onSubmit={handleSendMessage} class="flex flex-col gap-2">
                                {/* Input Area */}
                                <div class="relative group">
                                    <div class="absolute top-0 left-0 bg-bb-accent text-bb-bg text-[10px] font-bold px-1">
                                        MSG ENTRY
                                    </div>
                                    <textarea
                                        value={msgInput()}
                                        onInput={(e) => setMsgInput(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                handleSendMessage(e);
                                            }
                                        }}
                                        class="w-full bg-black text-bb-text placeholder-bb-muted/50 p-2 pt-5 text-sm font-mono outline-none resize-none h-20 border border-bb-border focus:border-bb-accent transition-colors"
                                        placeholder="// Type message..."
                                        disabled={!selectedConversation()}
                                    />
                                    <div class="absolute bottom-2 right-2 flex gap-3 text-bb-muted text-[10px]">
                                        <span class="cursor-pointer hover:text-bb-accent">[ATTACH]</span>
                                        <span class="cursor-pointer hover:text-bb-accent">[LINK]</span>
                                        <span class="cursor-pointer hover:text-market-down">[FLAG]</span>
                                    </div>
                                </div>

                                {/* Trade Ticket Fields Row (Simplified for style) */}
                                <div class="flex gap-1 text-[10px] font-mono opacity-60">
                                    <div class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-muted flex-1">
                                        SEC: <span class="text-bb-accent">--</span>
                                    </div>
                                    <div class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-muted w-20">
                                        SIDE: <span class="text-bb-accent">--</span>
                                    </div>
                                    <div class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-muted w-24 text-right">
                                        QTY: <span class="text-bb-accent">0</span>
                                    </div>
                                </div>

                                {/* Bottom Controls Row */}
                                <div class="flex items-center gap-1 text-[10px] mt-1 font-mono">
                                    <button
                                        type="button"
                                        onClick={loadConversations}
                                        class="bg-bb-bg border border-bb-border text-bb-text w-6 h-6 flex items-center justify-center hover:bg-bb-border hover:text-bb-accent transition-colors"
                                        title="Refresh"
                                    >
                                        R
                                    </button>
                                    
                                    <div class="flex-1"></div>

                                    <button
                                        type="submit"
                                        disabled={!selectedConversation() || !msgInput().trim()}
                                        class="bg-bb-accent text-bb-bg border border-bb-accent px-4 h-6 hover:brightness-110 font-bold disabled:opacity-50 disabled:grayscale transition-all uppercase"
                                    >
                                        &gt; TRANSMIT
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            </Show>
        </Panel>
    );
};
