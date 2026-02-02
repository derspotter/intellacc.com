import { For } from "solid-js";
import { marketStore } from "../../store/marketStore";
import { clsx } from "clsx";

export const MarketList = () => {
    return (
        <div class="flex flex-col h-full bg-bb-bg text-xs font-mono">
            <div class="grid grid-cols-12 gap-2 p-2 border-b border-bb-border text-bb-muted bg-bb-panel">
                <div class="col-span-1">ID</div>
                <div class="col-span-6">MARKET / EVENT</div>
                <div class="col-span-2 text-right">PROB</div>
                <div class="col-span-3 text-right">STATUS</div>
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
                            <div class="col-span-6 truncate text-bb-text">{market.event}</div>
                            <div class="col-span-2 text-right text-market-up font-bold">{market.confidence}%</div>
                            <div class="col-span-3 text-right text-bb-muted uppercase">{market.outcome || 'OPEN'}</div>
                        </div>
                    )}
                </For>
            </div>
        </div>
    );
};
