import { For, Show } from "solid-js";
import { marketStore } from "../../store/marketStore";
import { clsx } from "clsx";

export const MarketList = () => {
    return (
        <div class="flex flex-col h-full bg-bb-bg text-xs font-mono">
            <div class="grid grid-cols-12 gap-2 p-2 border-b border-bb-border text-bb-muted bg-bb-panel">
                <div class="col-span-1">ID</div>
                <div class="col-span-6">EVENT</div>
                <div class="col-span-2 text-right">PROB</div>
                <div class="col-span-3 text-right">CLOSE / OUT</div>
            </div>

            <div class="flex-1 overflow-auto custom-scrollbar">
                <For each={marketStore.state.markets}>
                    {(market) => (
                        <div
                            class={clsx(
                                "grid grid-cols-12 gap-2 p-2 border-b border-bb-border/20 cursor-pointer hover:bg-bb-accent/10 transition-colors",
                                marketStore.state.selectedMarketId === market.id ? "bg-bb-accent/20 border-l-2 border-l-bb-accent" : ""
                            )}
                            onClick={() => marketStore.selectMarket(market.id)}
                        >
                            <div class="col-span-1 text-bb-muted">{market.id.toString().substring(0, 4)}</div>
                            <div class="col-span-6 truncate text-bb-text">{market.title}</div>
                            <div class="col-span-2 text-right text-market-up font-bold">
                                {market.market_prob != null ? `${(Number(market.market_prob) * 100).toFixed(1)}%` : "--"}
                            </div>
                            <div class="col-span-3 text-right text-bb-muted uppercase truncate">
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
            </div>
        </div>
    );
};
