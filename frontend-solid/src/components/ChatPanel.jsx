import { createSignal, Show, For, createEffect, onMount } from "solid-js";
import { Panel } from "./ui/Panel";
import vaultService from "../services/mls/vaultService";
import vaultStore from "../store/vaultStore";
import { userData } from "../services/tokenService";
import { useSocket } from "../services/socket";
import { api } from "../services/api";

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

    const socket = useSocket();

    // Load conversations when vault is unlocked
    createEffect(() => {
        if (!vaultStore.state.locked) {
            loadConversations();
        }
    });

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
        } catch (err) {
            console.error('[ChatPanel] Failed to load conversations:', err);
        } finally {
            setLoadingConvs(false);
        }
    };

    const selectConversation = async (conv) => {
        setSelectedConversation(conv);
        setMessages([]);

        try {
            const convId = conv.group_id || conv.id;
            const msgs = await api.mls.getMessages(convId, { limit: 50 });
            setMessages(Array.isArray(msgs) ? msgs : []);
        } catch (err) {
            console.error('[ChatPanel] Failed to load messages:', err);
        }
    };

    const handleSendMessage = (e) => {
        e.preventDefault();
        if (!msgInput().trim() || !selectedConversation()) return;

        console.log('[ChatPanel] Sending:', msgInput(), 'to:', selectedConversation()?.displayName);
        socket.sendMessage(msgInput());

        // Optimistic update
        setMessages(prev => [...prev, {
            id: Date.now(),
            content: msgInput(),
            sender: userData()?.username || 'me',
            timestamp: new Date().toISOString()
        }]);

        setMsgInput("");
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
        <Panel title="[3] COMMS // E2EE" class="h-full flex flex-col">
            <Show when={vaultStore.state.locked}>
                <div class="flex-1 flex flex-col items-center justify-center p-4">
                    <div class="w-full max-w-xs border border-bb-border p-4 bg-bb-panel">
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
                <div class="flex flex-1 min-h-0 bg-[#111] text-xs font-sans">
                    {/* === LEFT SIDEBAR === */}
                    <div class="w-[200px] min-w-[160px] border-r border-[#333] flex flex-col bg-[#111]">
                        {/* Header */}
                        <div class="bg-[#222] text-white px-3 py-2 flex items-center justify-between border-b border-[#333]">
                            <span class="font-bold text-xs bg-[#444] px-2 py-0.5">IB MANAGER</span>
                            <span class="text-[#888] text-xs cursor-pointer hover:text-white">🔔</span>
                        </div>

                        {/* Search/Add Bar */}
                        <div class="bg-[#F5A623] flex items-center px-2 py-1 gap-1">
                            <input
                                class="flex-1 bg-transparent border-none outline-none text-black placeholder-black/50 text-xs font-bold h-7"
                                placeholder="Search..."
                            />
                            <span class="text-black font-bold cursor-pointer hover:text-white text-lg">+</span>
                        </div>

                        {/* Conversations List */}
                        <div class="flex-1 overflow-y-auto">
                            <div class="text-[11px] text-[#888] uppercase px-3 py-2 flex items-center gap-1 cursor-pointer hover:text-white select-none">
                                <span class="text-[9px]">▼</span> Chats
                            </div>

                            <Show when={loadingConvs()}>
                                <div class="text-[#999] text-center py-2 text-xs">Loading...</div>
                            </Show>

                            <Show when={!loadingConvs() && conversations().length === 0}>
                                <div class="text-[#999] text-center py-4 text-xs px-2">
                                    No conversations yet.<br />Start a new chat!
                                </div>
                            </Show>

                            <For each={conversations()}>
                                {(conv) => (
                                    <div
                                        onClick={() => selectConversation(conv)}
                                        class={`px-3 py-2 cursor-pointer flex justify-between items-center transition-colors border-b border-[#222] ${selectedConversation()?.id === conv.id || selectedConversation()?.group_id === conv.group_id
                                            ? 'bg-[#333] text-white font-bold'
                                            : 'text-[#F5A623] hover:bg-[#222]'
                                            }`}
                                    >
                                        <span class="truncate text-xs">
                                            {conv.type === 'group' ? '👥 ' : ''}{conv.displayName}
                                        </span>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>

                    {/* === RIGHT MAIN CHAT AREA === */}
                    <div class="flex-1 flex flex-col bg-[#111] min-w-0">
                        {/* Chat Header */}
                        <div class="border-b border-[#333] px-4 py-2 flex items-center gap-3 bg-[#1a1a1a]">
                            <Show when={selectedConversation()}>
                                <div class="w-2.5 h-2.5 rounded-full bg-[#00ff00]"></div>
                                <span class="font-bold text-white text-sm">{selectedConversation()?.displayName}</span>
                            </Show>
                            <Show when={!selectedConversation()}>
                                <span class="text-[#999] text-sm">Select a conversation</span>
                            </Show>
                            <div class="ml-auto flex gap-4 text-[#888] text-sm">
                                <span class="cursor-pointer hover:text-white">📞</span>
                                <span class="cursor-pointer hover:text-white">👤</span>
                                <span class="cursor-pointer hover:text-white">≡</span>
                            </div>
                        </div>

                        {/* Messages Area */}
                        <div class="flex-1 overflow-y-auto p-4 font-mono text-xs">
                            <Show when={!selectedConversation()}>
                                <div class="text-[#888] text-center mt-12 text-sm">
                                    Select a conversation to view messages
                                </div>
                            </Show>

                            <Show when={selectedConversation() && messages().length === 0}>
                                <div class="text-[#888] italic text-sm">No messages yet. Start the conversation.</div>
                            </Show>

                            <For each={messages()}>
                                {(msg) => (
                                    <div class="mb-3">
                                        <span class="text-[#F5A623] font-bold mr-2 text-sm">
                                            {(msg.sender || msg.sender_username || 'UNKNOWN').toUpperCase()}
                                        </span>
                                        <div class="flex gap-4 text-[#ddd] text-sm leading-relaxed">
                                            <span class="text-[#888] shrink-0 font-normal text-xs pt-0.5">
                                                {new Date(msg.timestamp || msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                                            </span>
                                            <span class="break-words">{msg.content || msg.plaintext || '[Encrypted]'}</span>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>

                        {/* === INPUT AREA === */}
                        <div class="border-t border-[#333] bg-[#1a1a1a] p-3 flex flex-col gap-2">
                            <form onSubmit={handleSendMessage} class="flex flex-col gap-2">
                                {/* Orange Text Input Area */}
                                <div class="relative">
                                    <textarea
                                        value={msgInput()}
                                        onInput={(e) => setMsgInput(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                handleSendMessage(e);
                                            }
                                        }}
                                        class="w-full bg-[#F5A623] text-black placeholder-black/50 p-2 text-sm font-bold outline-none resize-none h-20 border border-[#333]"
                                        placeholder=""
                                        disabled={!selectedConversation()}
                                    />
                                    <div class="absolute bottom-2 right-2 flex gap-3 text-black/70 text-xs">
                                        <span class="cursor-pointer hover:text-black font-bold">⬇</span>
                                        <span class="cursor-pointer hover:text-black font-bold">🔗</span>
                                        <span class="cursor-pointer hover:text-black font-bold">🚩</span>
                                    </div>
                                </div>

                                {/* Trade Ticket Fields Row */}
                                <div class="flex gap-1 text-xs">
                                    <div class="bg-[#F5A623] text-white px-3 py-2 font-bold flex-1 border border-[#333] flex items-center h-9">
                                        Security
                                    </div>
                                    <div class="bg-[#F5A623] text-white px-3 py-2 font-bold w-24 border border-[#333] flex items-center justify-between cursor-pointer h-9">
                                        Side <span class="text-[10px]">▼</span>
                                    </div>
                                    <div class="bg-[#F5A623] text-white px-3 py-2 font-bold w-28 text-right border border-[#333] flex items-center justify-end h-9">
                                        Quantity
                                    </div>
                                </div>

                                {/* Bottom Controls Row */}
                                <div class="flex items-center gap-1 text-xs mt-1">
                                    <button
                                        type="button"
                                        onClick={loadConversations}
                                        class="bg-[#222] border border-[#444] text-[#ccc] w-9 h-9 flex items-center justify-center hover:bg-[#333] hover:text-white transition-colors"
                                    >
                                        <span class="text-sm">↻</span>
                                    </button>
                                    <button type="button" class="bg-[#222] border border-[#444] text-[#ccc] w-9 h-9 flex items-center justify-center hover:bg-[#333] hover:text-white transition-colors">
                                        <span class="text-sm">↗</span>
                                    </button>
                                    <button type="button" class="bg-[#222] border border-[#444] text-[#ccc] px-4 h-9 hover:bg-[#333] hover:text-white flex items-center gap-1 transition-colors font-medium">
                                        More Fields <span class="text-[10px]">⌃</span>
                                    </button>
                                    <button type="button" class="bg-[#222] border border-[#444] text-[#ccc] px-4 h-9 hover:bg-[#333] hover:text-white transition-colors font-medium">
                                        Clear Fields
                                    </button>

                                    <div class="flex-1"></div>

                                    {/* Right aligned controls */}
                                    <button type="button" class="bg-[#222] border border-[#444] text-[#ccc] w-9 h-9 flex items-center justify-center hover:bg-[#333] hover:text-white transition-colors">
                                        <span class="text-sm">≡</span>
                                    </button>
                                    <button type="button" class="bg-[#222] border border-[#444] text-[#ccc] w-9 h-9 flex items-center justify-center hover:bg-[#333] hover:text-white transition-colors">
                                        <span class="text-sm">↑</span>
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={!selectedConversation() || !msgInput().trim()}
                                        class="bg-[#333] border border-[#555] text-white px-6 h-9 hover:bg-[#444] font-bold disabled:opacity-50 ml-1 transition-colors text-sm"
                                    >
                                        Send IB
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
