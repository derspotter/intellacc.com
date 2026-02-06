import { Show } from "solid-js";
import { Panel } from "./ui/Panel";
import { MarketList } from "./market/MarketList";
import { MarketDetail } from "./market/MarketDetail";
import { MarketTicker } from "./market/MarketTicker";
import { marketStore } from "../store/marketStore";

export const MarketPanel = () => {
    return (
        <div class="flex flex-col gap-px h-full">
            {/* Top Half: List & Ticker */}
            <Panel title="[2] MARKET DATA // QUOTES" class="h-3/5 flex flex-col">
                <div class="shrink-0 z-10">
                    <MarketTicker />
                </div>
                <div class="flex-1 min-h-0">
                    <Show when={!marketStore.state.loading} fallback={<div class="p-4 text-bb-muted animate-pulse">Loading Markets...</div>}>
                        <MarketList />
                    </Show>
                </div>
            </Panel>

            {/* Bottom Half: Details & Order Book */}
            <Panel title="ORDER BOOK // DEPTH" class="h-2/5">
                <MarketDetail />
            </Panel>
        </div>
    );
};
