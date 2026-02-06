import { createStore } from "solid-js/store";
import { api } from "../services/api";
import { getToken } from "../services/tokenService";

const [state, setState] = createStore({
    markets: [],
    loading: false,
    error: null,
    selectedMarketId: null
});

const loadMarkets = async () => {
    // Skip fetch if not authenticated (consistent with other panels)
    if (!getToken()) {
        setState({ markets: [], loading: false, error: null });
        return;
    }
    setState({ loading: true, error: null });
    try {
        // "Markets" are events with attached market fields (market_prob, cumulative_stake, etc).
        const markets = await api.events.getAll();
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

const applyMarketUpdate = (update) => {
    if (!update || update.eventId == null) return;
    const marketProb = update.market_prob != null ? Number(update.market_prob) : null;
    const cumulativeStake = update.cumulative_stake != null ? Number(update.cumulative_stake) : null;

    setState("markets", (markets) =>
        markets.map(m => {
            if (m.id !== Number(update.eventId)) return m;

            // Prepare updates
            const updates = {};
            
            if (marketProb != null) {
                updates.market_prob = marketProb;
                // Track previous probability if it existed
                if (m.market_prob != null) {
                    updates.prev_market_prob = m.market_prob;
                }
            }
            
            if (cumulativeStake != null) {
                updates.cumulative_stake = cumulativeStake;
                // Track previous stake if it existed
                if (m.cumulative_stake != null) {
                    updates.prev_cumulative_stake = m.cumulative_stake;
                }
            }

            return {
                ...m,
                ...updates
            };
        })
    );
};

const clear = () => {
    setState({ markets: [], loading: false, error: null, selectedMarketId: null });
};

export const marketStore = {
    state,
    loadMarkets,
    selectMarket,
    getSelectedMarket,
    applyMarketUpdate,
    clear
};
