import { createStore } from "solid-js/store";

const [vaultState, setVaultState] = createStore({
    exists: false,
    locked: true,
    userId: null,
    lastActivity: Date.now()
});

export const vaultStore = {
    state: vaultState,

    setVaultExists(exists) {
        setVaultState('exists', exists);
    },

    setLocked(locked) {
        setVaultState('locked', locked);
    },

    setUserId(id) {
        setVaultState('userId', id);
    },

    updateActivity() {
        setVaultState('lastActivity', Date.now());
    },

    // Getters for compatibility
    get userId() { return vaultState.userId; },
    get isLocked() { return vaultState.locked; }
};

export default vaultStore;
