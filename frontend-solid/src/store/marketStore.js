import { createStore } from "solid-js/store";
import { api } from "../services/api";
import { useSocket } from "../services/socket";
import { getToken } from "../services/tokenService";

const [state, setState] = createStore({
    markets: [],
    loading: false,
    error: null,
    selectedMarketId: null
});

const loadMarkets = async () => {
    // Skip fetch if not authenticated
    if (!getToken()) {
        setState({ markets: [], loading: false, error: null });
        return;
    }
    setState({ loading: true, error: null });
    try {
        const markets = await api.predictions.getAll();
        setState({
            markets: Array.isArray(markets) ? markets : [],
            loading: false
        });
    } catch (err) {
        console.error("Failed to load markets", err);
        setState({ error: err.message, loading: false });
    }
};

const selectMarket = (id) => {
    setState("selectedMarketId", id);
};

// Computed helper (Solid stores are proxies, regular functions work fine)
const getSelectedMarket = () => {
    return state.markets.find(m => m.id === state.selectedMarketId);
};

// Socket integration can be called from App or here if we pass the socket instance
// For simplicity, we'll expose a setup function
const setupSocketListeners = (socket) => {
    if (!socket) return;

    socket.on('newPrediction', (market) => {
        setState("markets", (prev) => [market, ...prev]);
    });

    socket.on('marketUpdate', (update) => {
        setState("markets", (markets) =>
            markets.map(m => m.id === update.id ? { ...m, ...update } : m)
        );
    });
};

export const marketStore = {
    state,
    loadMarkets,
    selectMarket,
    getSelectedMarket,
    setupSocketListeners
};
