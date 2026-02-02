// frontend/src/components/UserSearch.js
// Inline New Conversation Panel - Add users to start DM or Group
import van from 'vanjs-core';
const { div, button, input, span, p, ul, li } = van.tags;
import { api } from '../services/api.js';
import messagingStore from '../stores/messagingStore.js';
import coreCryptoClient from '../services/mls/coreCryptoClient.js';
import messagingService from '../services/messaging.js';

let searchTimeout = null;

/**
 * Inline New Conversation Panel (replaces sidebar content when active)
 * Add 1 user for DM, or multiple users for a group
 * @param {Object} props
 * @param {Function} props.onClose - Callback to close/cancel
 */
export function NewConversationPanel({ onClose }) {
    const searchQuery = van.state('');
    const searchResults = van.state([]);
    const selectedUsers = van.state([]); // Array of {id, username}
    const groupName = van.state('');
    const isSearching = van.state(false);
    const isCreating = van.state(false);
    const error = van.state('');

    // Debounced search function
    const performSearch = async (query) => {
        if (!query.trim()) {
            searchResults.val = [];
            return;
        }

        isSearching.val = true;
        error.val = '';

        try {
            const results = await api.users.search(query);
            const selectedIds = selectedUsers.val.map(u => u.id);
            searchResults.val = (results || []).filter(u => !selectedIds.includes(u.id));
        } catch (err) {
            console.error('[NewConversation] Search error:', err);
            error.val = 'Failed to search users';
            searchResults.val = [];
        } finally {
            isSearching.val = false;
        }
    };

    const handleInputChange = (e) => {
        const query = e.target.value;
        searchQuery.val = query;
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => performSearch(query), 300);
    };

    const addUser = (user) => {
        selectedUsers.val = [...selectedUsers.val, { id: user.id, username: user.username }];
        searchQuery.val = '';
        searchResults.val = [];
    };

    const removeUser = (userId) => {
        selectedUsers.val = selectedUsers.val.filter(u => u.id !== userId);
    };

    const startConversation = async () => {
        const users = selectedUsers.val;
        if (users.length === 0) return;

        isCreating.val = true;
        error.val = '';

        try {
            let groupId;

            if (users.length === 1) {
                const result = await coreCryptoClient.startDirectMessage(users[0].id);
                groupId = result.groupId;
                const dms = await api.mls.getDirectMessages();
                messagingStore.setDirectMessages(dms);
            } else {
                const name = groupName.val.trim() || `Group (${users.length + 1})`;
                const group = await coreCryptoClient.createGroup(name);
                groupId = group.group_id;

                for (const user of users) {
                    await coreCryptoClient.inviteToGroup(groupId, user.id);
                }

                const groups = await messagingService.getMlsGroups();
                messagingStore.setMlsGroups(groups);
            }

            messagingStore.selectMlsGroup(groupId);
            onClose();
        } catch (err) {
            console.error('[NewConversation] Error:', err);
            error.val = err.message || 'Failed to start conversation';
        } finally {
            isCreating.val = false;
        }
    };

    return div({ class: "new-conversation-panel" }, [
        // Search input (matches conversations search bar)
        div({ class: "search-box" }, [
            input({
                type: "text",
                class: "form-input",
                placeholder: "Search users...",
                value: searchQuery,
                oninput: handleInputChange,
                autofocus: true
            })
        ]),

        // Selected users as chips
        () => {
            const users = selectedUsers.val;
            if (users.length === 0) return div({ class: "selected-users-placeholder" });
            return div({ class: "selected-users" },
                ...users.map(user => span({ class: "user-chip" },
                    span(user.username),
                    button({ class: "chip-remove", onclick: () => removeUser(user.id) }, "\u00D7")
                ))
            );
        },

        // Group name input (only for 2+ users)
        () => {
            if (selectedUsers.val.length < 2) return div({ class: "group-name-placeholder" });
            return div({ class: "group-name-row" },
                input({
                    type: "text",
                    class: "form-input",
                    placeholder: "Group name (optional)",
                    value: groupName,
                    oninput: (e) => { groupName.val = e.target.value; }
                })
            );
        },

        // Error display
        () => error.val ? div({ class: "panel-error" }, error.val) : div({ class: "panel-error-placeholder" }),

        // Search results - using van.derive for proper reactivity
        () => {
            const searching = isSearching.val;
            const query = searchQuery.val;
            const results = searchResults.val;

            if (searching) return div({ class: "search-results-inline" }, p({ class: "hint" }, "Searching..."));
            if (!query.trim()) return div({ class: "search-results-inline" });
            if (results.length === 0) return div({ class: "search-results-inline" }, p({ class: "hint" }, "No users found"));

            return div({ class: "search-results-inline" },
                ul({ class: "user-list-inline" },
                    ...results.map(user => li({
                        class: "user-row",
                        onclick: () => addUser(user)
                    },
                        span({ class: "user-avatar-sm" }, user.username?.[0]?.toUpperCase() || "?"),
                        span({ class: "user-name" }, user.username),
                        span({ class: "add-btn" }, "+")
                    ))
                )
            );
        },

        // Start button
        () => {
            const users = selectedUsers.val;
            if (users.length === 0) return div({ class: "panel-actions-placeholder" });
            return div({ class: "panel-actions" },
                button({
                    class: "btn btn-primary btn-block",
                    onclick: startConversation,
                    disabled: isCreating.val
                }, () => {
                    if (isCreating.val) return "Creating...";
                    return users.length === 1 ? "Start DM" : "Create Group";
                })
            );
        }
    ]);
}

export default NewConversationPanel;
