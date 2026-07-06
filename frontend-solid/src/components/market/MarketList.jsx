import { For, Show } from "solid-js";
import { marketStore } from "../../store/marketStore";
import { clsx } from "clsx";

export const MarketList = () => {
    return (
        <div class="flex flex-col h-full bg-bb-bg text-xs font-mono">
            {/* Dense "table" layout: pack columns (no wide fractional gutters) */}
            <div class="grid grid-cols-[minmax(0,1fr)_max-content] sm:grid-cols-[4ch_minmax(0,1fr)_max-content_max-content] gap-x-0 px-2 py-1 border-b border-bb-border text-bb-muted bg-bb-panel">
                <div class="hidden sm:block pr-2">ID</div>
                <div class="min-w-0 truncate sm:border-l sm:border-bb-border/50 sm:px-2">EVENT</div>
                <div class="border-l border-bb-border/50 px-2 text-right">PROB</div>
                <div class="hidden sm:block border-l border-bb-border/50 px-2 text-right">CLOSE / OUT</div>
            </div>

            <div class="flex-1 overflow-auto custom-scrollbar">
                <For each={marketStore.state.markets}>
                    {(market, index) => (
                        <div
                            data-testid="market-row"
                            class={clsx(
                                "grid grid-cols-[minmax(0,1fr)_max-content] sm:grid-cols-[4ch_minmax(0,1fr)_max-content_max-content] gap-x-0 px-2 py-0.5 border-b border-bb-border/20 cursor-pointer transition-colors",
                                marketStore.state.selectedMarketId === market.id
                                    ? "bg-bb-accent text-black font-bold"
                                    : [
                                        index() % 2 === 0 ? "bg-bb-bg" : "bg-[#0a0a0a]",
                                        "hover:bg-bb-accent/10"
                                    ]
                            )}
                            onClick={() => marketStore.selectMarket(market.id)}
                        >
                            <div class={clsx("hidden sm:block pr-2", marketStore.state.selectedMarketId === market.id ? "text-black" : "text-bb-muted")}>{market.id.toString().substring(0, 4)}</div>
                            <div class={clsx("min-w-0 truncate sm:border-l sm:border-bb-border/50 sm:px-2", marketStore.state.selectedMarketId === market.id ? "text-black" : "text-bb-text")}>{market.title}</div>
                            <div class="border-l border-bb-border/50 px-2 text-right text-market-up font-bold">
                                {market.market_prob != null ? `${(Number(market.market_prob) * 100).toFixed(1)}%` : "--"}
                            </div>
                            <div class="hidden sm:block border-l border-bb-border/50 px-2 text-right text-bb-muted uppercase truncate">
                                <Show when={market.outcome} fallback={
                                    market.closing_date 
                                        ? new Date(market.closing_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-') 
                                        : "OPEN"
                                }>
                                    <span class="text-bb-accent font-bold border border-bb-accent/50 px-1 rounded bg-bb-accent/10">
                                        {market.outcome}
                                    </span>
                                </Show>
                            </div>
                        </div>
                    )}
                </For>
                <Show when={marketStore.state.markets.length === 0 && !marketStore.state.loading}>
                    <div data-testid="market-empty" class="p-4 text-center text-bb-muted">NO MARKETS MATCH</div>
                </Show>
                <Show when={marketStore.state.hasMore}>
                    <button
                        type="button"
                        data-testid="market-load-more"
                        class="w-full py-2 text-center text-bb-accent border-b border-bb-border/20 hover:bg-bb-accent/10 uppercase font-bold disabled:opacity-50"
                        disabled={marketStore.state.loadingMore}
                        onClick={() => marketStore.loadMore()}
                    >
                        {marketStore.state.loadingMore ? 'LOADING...' : `LOAD MORE (${marketStore.state.markets.length}/${marketStore.state.total})`}
                    </button>
                </Show>
            </div>
        </div>
    );
};
