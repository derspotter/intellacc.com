import { createStore } from "solid-js/store";
import { api } from "../services/api";
import { getToken } from "../services/tokenService";

const PAGE_SIZE = 100;

const [state, setState] = createStore({
    markets: [],
    total: 0,
    hasMore: false,
    search: '',
    loading: false,
    loadingMore: false,
    error: null,
    selectedMarketId: null
});

const fetchPage = async ({ reset }) => {
    if (!getToken()) {
        setState({ markets: [], total: 0, hasMore: false, loading: false, loadingMore: false, error: null });
        return;
    }
    const offset = reset ? 0 : state.markets.length;
    setState(reset ? { loading: true, error: null } : { loadingMore: true, error: null });
    try {
        const res = await api.events.getPage({ search: state.search, limit: PAGE_SIZE, offset });
        const items = Array.isArray(res?.items) ? res.items : [];
        setState({
            markets: reset ? items : [...state.markets, ...items],
            total: Number(res?.total) || items.length,
            hasMore: Boolean(res?.hasMore),
            loading: false,
            loadingMore: false
        });
    } catch (err) {
        console.error("Failed to load markets", err);
        setState({ error: err.message, loading: false, loadingMore: false });
    }
};

// "Markets" are events with attached market fields (market_prob, cumulative_stake, etc).
const loadMarkets = () => fetchPage({ reset: true });

const loadMore = () => {
    if (state.loadingMore || state.loading || !state.hasMore) return;
    return fetchPage({ reset: false });
};

const setSearch = (query) => {
    setState('search', query);
    return fetchPage({ reset: true });
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
    setState({ markets: [], total: 0, hasMore: false, search: '', loading: false, loadingMore: false, error: null, selectedMarketId: null });
};

export const marketStore = {
    state,
    loadMarkets,
    loadMore,
    setSearch,
    selectMarket,
    getSelectedMarket,
    applyMarketUpdate,
    clear
};
