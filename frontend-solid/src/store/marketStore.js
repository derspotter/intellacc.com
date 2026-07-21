import { createStore } from "solid-js/store";
import { api } from "../services/api";
import { getToken } from "../services/tokenService";
import { createEpochGuard } from "../lib/requestEpoch";

const PAGE_SIZE = 100;

const [state, setState] = createStore({
    markets: [],
    total: 0,
    hasMore: false,
    search: '',
    loading: false,
    loadingMore: false,
    error: null,
    selectedMarketId: null,
    serverCount: 0
});

const guard = createEpochGuard();
let activeFetch = null;

const doFetchPage = async ({ reset }) => {
    if (!getToken()) {
        setState({ markets: [], total: 0, hasMore: false, loading: false, loadingMore: false, error: null, serverCount: 0 });
        return;
    }
    const token = guard.begin();
    const offset = reset ? 0 : state.serverCount;
    setState(reset ? { loading: true, loadingMore: false, error: null } : { loadingMore: true, error: null });
    try {
        const res = await api.events.getPage({ search: state.search, limit: PAGE_SIZE, offset });
        if (!guard.isCurrent(token)) return; // superseded by a newer request
        const items = Array.isArray(res?.items) ? res.items : [];
        setState({
            markets: reset ? items : [...state.markets, ...items.filter(m => !state.markets.some(x => x.id === m.id))],
            total: Number(res?.total) || items.length,
            hasMore: Boolean(res?.hasMore),
            serverCount: reset ? items.length : state.serverCount + items.length,
            loading: false,
            loadingMore: false
        });
    } catch (err) {
        if (!guard.isCurrent(token)) return;
        console.error("Failed to load markets", err);
        setState({ error: err.message, loading: false, loadingMore: false });
    }
};

const fetchPage = (opts) => {
    const p = doFetchPage(opts);
    activeFetch = p;
    p.finally(() => { if (activeFetch === p) activeFetch = null; });
    return p;
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

// Ensures a specific market is present in state.markets and selected, even if
// it isn't on the currently loaded page(s). Used by the #predictions/:id deep
// link. Deliberately does NOT touch total/hasMore: this is a targeted fetch
// for one market, not a page of results.
const ensureMarket = async (id) => {
    if (!Number.isFinite(id)) return;
    if (activeFetch) {
        try { await activeFetch; } catch { /* load errors surface elsewhere */ }
    }
    if (state.markets.some(m => m.id === id)) {
        selectMarket(id);
        return;
    }
    try {
        const market = await api.events.getById(id);
        if (!market?.id) return;
        setState('markets', (prev) => prev.some(m => m.id === market.id) ? prev : [market, ...prev]);
        selectMarket(market.id);
    } catch (err) {
        console.error('ensureMarket failed', err);
    }
};

// Re-fetches one market's row after an embedded trade (numeric/multi-outcome
// cards trade via their own endpoints, so no socket-independent refresh would
// otherwise reach the detail header's prob/stake readouts). Routes through
// applyMarketUpdate so prev_* flash tracking behaves exactly like a socket tick.
const refreshMarket = async (id) => {
    if (!Number.isFinite(Number(id))) return;
    try {
        const market = await api.events.getById(id);
        if (!market?.id) return;
        applyMarketUpdate({
            eventId: market.id,
            market_prob: market.market_prob,
            cumulative_stake: market.cumulative_stake
        });
    } catch (err) {
        console.error('refreshMarket failed', err);
    }
};

const clear = () => {
    guard.invalidate(); // invalidate any in-flight fetch so it can't repopulate cleared state
    setState({ markets: [], total: 0, hasMore: false, search: '', loading: false, loadingMore: false, error: null, selectedMarketId: null, serverCount: 0 });
};

export const marketStore = {
    state,
    loadMarkets,
    loadMore,
    setSearch,
    selectMarket,
    getSelectedMarket,
    applyMarketUpdate,
    ensureMarket,
    refreshMarket,
    clear
};
