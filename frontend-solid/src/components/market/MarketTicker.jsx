import { For, Show } from "solid-js";
import { marketStore } from "../../store/marketStore";

export const MarketTicker = () => {
    return (
        <div class="h-6 bg-bb-bg border-b border-bb-border flex items-center overflow-hidden whitespace-nowrap relative">
            {/* Animated Marquee Container */}
            <div class="animate-marquee flex gap-8 items-center px-4">
                <For each={marketStore.state.markets.slice(0, 10)}>
                    {(market) => (
                        <div class="flex gap-2 text-xs font-mono">
                            <span class="text-bb-accent font-bold uppercase">{market.event?.substring(0, 15)}...</span>
                            <span class="text-market-up">P: {market.confidence}%</span>
                            <span class="text-bb-muted">VOL: {(Math.random() * 1000).toFixed(0)}</span>
                        </div>
                    )}
                </For>
            </div>
        </div>
    );
};
