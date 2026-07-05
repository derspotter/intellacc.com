import { Show, createSignal, createEffect, onCleanup } from "solid-js";
import { clsx } from "clsx";
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

    // Single list + single detail. On < md, selection swaps list for detail;
    // on md+ both show in a 3/5 - 2/5 vertical split.
    return (
        <div class="h-full flex flex-col md:gap-px">
            <Panel
                title="[2] MARKET DATA // QUOTES"
                class={clsx(
                    "flex-col md:!flex md:h-3/5",
                    hasSelection() ? "hidden" : "flex h-full md:h-3/5"
                )}
            >
                <div class="shrink-0 z-10">
                    <MarketTicker />
                </div>
                <MarketSearchRow />
                <div class="flex-1 min-h-0">
                    <Show when={!marketStore.state.loading} fallback={<div class="p-4 text-bb-muted animate-pulse">Loading Markets...</div>}>
                        <MarketList />
                    </Show>
                </div>
            </Panel>

            <Panel
                title="ORDER BOOK // DEPTH"
                class={clsx(
                    "md:!flex md:h-2/5",
                    hasSelection() ? "flex h-full md:h-2/5" : "hidden"
                )}
            >
                <MarketDetail />
            </Panel>
        </div>
    );
};
