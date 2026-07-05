import { Show, createSignal, createEffect, onCleanup } from "solid-js";
import { Panel } from "./ui/Panel";
import { MarketList } from "./market/MarketList";
import { MarketDetail } from "./market/MarketDetail";
import { MarketTicker } from "./market/MarketTicker";
import { marketStore } from "../store/marketStore";

const MarketSearchRow = () => {
    let debounceTimer;
    let inputEl;
    const [value, setValue] = createSignal(marketStore.state.search);
    onCleanup(() => clearTimeout(debounceTimer));

    createEffect(() => {
        const s = marketStore.state.search;
        if (typeof document === 'undefined' || document.activeElement !== inputEl) {
            setValue(s);
        }
    });

    const onInput = (e) => {
        const q = e.currentTarget.value;
        setValue(q);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => marketStore.setSearch(q.trim()), 300);
    };

    return (
        <div class="shrink-0 border-b border-bb-border bg-bb-panel px-2 py-1 flex items-center gap-2 font-mono text-xs">
            <span class="text-bb-accent font-bold">/</span>
            <input
                type="text"
                data-testid="market-search"
                class="flex-1 bg-transparent border-none outline-none text-bb-text placeholder-bb-muted"
                placeholder="SEARCH MARKETS..."
                value={value()}
                onInput={onInput}
                ref={el => inputEl = el}
            />
            <span data-testid="market-count" class="text-bb-muted">
                {marketStore.state.markets.length}/{marketStore.state.total}
            </span>
        </div>
    );
};

export const MarketPanel = () => {
    const hasSelection = () => marketStore.state.selectedMarketId != null;

    return (
        <div class="h-full">
            {/* Mobile (< md): show list OR detail */}
            <div class="md:hidden h-full">
                <Show when={!hasSelection()}>
                    <Panel title="[2] MARKET DATA // QUOTES" class="h-full flex flex-col">
                        <div class="shrink-0 z-10">
                            <MarketTicker />
                            <MarketSearchRow />
                        </div>
                        <div class="flex-1 min-h-0">
                            <Show when={!marketStore.state.loading} fallback={<div class="p-4 text-bb-muted animate-pulse">Loading Markets...</div>}>
                                <MarketList />
                            </Show>
                        </div>
                    </Panel>
                </Show>

                <Show when={hasSelection()}>
                    <Panel title="ORDER BOOK // DEPTH" class="h-full">
                        <MarketDetail />
                    </Panel>
                </Show>
            </div>

            {/* Tablet+ (md+): keep current split */}
            <div class="hidden md:flex md:flex-col md:gap-px h-full">
                {/* Top Half: List & Ticker */}
                <Panel title="[2] MARKET DATA // QUOTES" class="md:h-3/5 flex flex-col">
                    <div class="shrink-0 z-10">
                        <MarketTicker />
                        <MarketSearchRow />
                    </div>
                    <div class="flex-1 min-h-0">
                        <Show when={!marketStore.state.loading} fallback={<div class="p-4 text-bb-muted animate-pulse">Loading Markets...</div>}>
                            <MarketList />
                        </Show>
                    </div>
                </Panel>

                {/* Bottom Half: Details & Order Book */}
                <Panel title="ORDER BOOK // DEPTH" class="md:h-2/5">
                    <MarketDetail />
                </Panel>
            </div>
        </div>
    );
};
