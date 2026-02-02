import { Show } from "solid-js";
import { marketStore } from "../../store/marketStore";

const OrderBookVisual = (props) => {
    // Mock order book visualization
    // A bar chart centered at 50%
    const prob = props.prob || 50;

    return (
        <div class="my-4 border border-bb-border p-2 bg-black">
            <div class="text-xs text-bb-muted mb-2 font-mono uppercase">Order Book Depth</div>
            <div class="flex items-center gap-1 h-32 relative">
                {/* Center Line */}
                <div class="absolute left-1/2 top-0 bottom-0 w-px bg-bb-border/50 border-dashed"></div>

                {/* Bids (Green) */}
                <div class="flex-1 flex flex-col items-end gap-0.5 opacity-80">
                    <div class="h-2 bg-market-up w-1/2"></div>
                    <div class="h-2 bg-market-up w-2/3"></div>
                    <div class="h-2 bg-market-up w-3/4"></div>
                    <div class="h-2 bg-market-up w-1/3"></div>
                    <div class="h-2 bg-market-up w-full"></div>
                </div>

                {/* Asks (Red/Orange) */}
                <div class="flex-1 flex flex-col items-start gap-0.5 opacity-80">
                    <div class="h-2 bg-market-down w-1/3"></div>
                    <div class="h-2 bg-market-down w-1/4"></div>
                    <div class="h-2 bg-market-down w-1/2"></div>
                    <div class="h-2 bg-market-down w-2/3"></div>
                    <div class="h-2 bg-market-down w-1/5"></div>
                </div>
            </div>
            <div class="flex justify-between text-xxs text-bb-muted mt-1 font-mono">
                <span>BIDS (YES)</span>
                <span>SPREAD: 2.5%</span>
                <span>ASKS (NO)</span>
            </div>
        </div>
    );
};

export const MarketDetail = () => {
    const market = marketStore.getSelectedMarket;

    return (
        <div class="h-full flex flex-col p-4 font-mono overflow-auto custom-scrollbar">
            <Show when={market()} fallback={<div class="text-center text-bb-muted mt-20">SELECT A MARKET DATA STREAM</div>}>
                <div class="border-b border-bb-border pb-2 mb-4">
                    <h2 class="text-lg font-bold text-bb-accent mb-1">{market().event}</h2>
                    <div class="flex justify-between text-xs text-bb-muted">
                        <span>ID: {market().id}</span>
                        <span>OPENED: {new Date(market().created_at).toLocaleDateString()}</span>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-4 mb-4">
                    <div class="bg-bb-panel border border-bb-border p-2">
                        <div class="text-xxs text-bb-muted uppercase">Current Probability</div>
                        <div class="text-2xl font-bold text-market-up">{market().confidence}%</div>
                    </div>
                    <div class="bg-bb-panel border border-bb-border p-2">
                        <div class="text-xxs text-bb-muted uppercase">Volume (24h)</div>
                        <div class="text-2xl font-bold text-bb-text">$12,450</div>
                    </div>
                </div>

                <OrderBookVisual prob={market().confidence} />

                {/* Action Buttons */}
                <div class="mt-auto grid grid-cols-2 gap-2">
                    <button class="bg-market-up/20 text-market-up border border-market-up hover:bg-market-up/30 py-2 font-bold uppercase text-sm">
                        BUY YES
                    </button>
                    <button class="bg-market-down/20 text-market-down border border-market-down hover:bg-market-down/30 py-2 font-bold uppercase text-sm">
                        BUY NO
                    </button>
                </div>
            </Show>
        </div>
    );
};
