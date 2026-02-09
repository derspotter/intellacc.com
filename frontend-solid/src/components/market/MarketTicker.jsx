import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { marketStore } from "../../store/marketStore";

const handleTickerClick = (id) => {
    marketStore.selectMarket(id);
};

const FlashValue = (props) => {
    const [colorClass, setColorClass] = createSignal(props.defaultColor);
    let timeout;

    createEffect(() => {
        const curr = Number(props.val);
        const prev = props.prev != null ? Number(props.prev) : null;

        if (curr != null && prev != null && curr !== prev) {
            const isUp = curr > prev;
            // Flash Green (up) or Red (down)
            setColorClass(isUp ? "text-market-up animate-pulse font-bold" : "text-market-down animate-pulse font-bold");

            clearTimeout(timeout);
            timeout = setTimeout(() => {
                setColorClass(props.defaultColor);
            }, 1500);
        }
    });

    onCleanup(() => clearTimeout(timeout));

    return (
        <span class={`transition-colors duration-300 ${colorClass()}`}>
            {props.val != null ? props.format(props.val) : "--"}
        </span>
    );
};

const TickerItem = (props) => {
    return (
        <div
            class="flex gap-2 text-xs font-mono cursor-pointer hover:bg-white/10 px-1 rounded transition-colors"
            onClick={() => handleTickerClick(props.market.id)}
        >
            <span class="text-bb-accent font-bold uppercase">{props.market.title}</span>
            <FlashValue
                val={props.market.market_prob}
                prev={props.market.prev_market_prob}
                format={(v) => `P: ${(Number(v) * 100).toFixed(1)}%`}
                defaultColor="text-market-up"
            />
            <FlashValue
                val={props.market.cumulative_stake}
                prev={props.market.prev_cumulative_stake}
                format={(v) => `STK: $${Number(v).toFixed(0)}`}
                defaultColor="text-bb-muted"
            />
        </div>
    );
};

export const MarketTicker = () => {
    return (
        <div class="h-6 bg-bb-bg border-b border-bb-border flex items-center overflow-hidden whitespace-nowrap relative">
            {/* Animated Marquee Container - Duplicated for seamless loop */}
            <div class="flex">
                <div class="animate-marquee flex gap-8 items-center px-4 shrink-0 min-w-full">
                    <For each={marketStore.state.markets.slice(0, 10)}>
                        {(market) => <TickerItem market={market} />}
                    </For>
                    {/* Placeholder if empty to maintain height/width */}
                    <Show when={marketStore.state.markets.length === 0}>
                        <span class="text-bb-muted text-xs font-mono">WAITING FOR MARKET DATA...</span>
                    </Show>
                </div>
                
                <div class="animate-marquee flex gap-8 items-center px-4 shrink-0 min-w-full">
                    <For each={marketStore.state.markets.slice(0, 10)}>
                        {(market) => <TickerItem market={market} />}
                    </For>
                    <Show when={marketStore.state.markets.length === 0}>
                        <span class="text-bb-muted text-xs font-mono">WAITING FOR MARKET DATA...</span>
                    </Show>
                </div>
            </div>
        </div>
    );
};
