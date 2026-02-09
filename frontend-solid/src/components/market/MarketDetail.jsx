import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { api } from "../../services/api";
import { marketStore } from "../../store/marketStore";

const FlashValueBig = (props) => {
    const [colorClass, setColorClass] = createSignal(props.defaultColor);
    let timeout;

    createEffect(() => {
        const curr = Number(props.val);
        const prev = props.prev != null ? Number(props.prev) : null;

        if (curr != null && prev != null && curr !== prev) {
            const isUp = curr > prev;
            setColorClass(isUp ? "text-market-up animate-pulse" : "text-market-down animate-pulse");

            clearTimeout(timeout);
            timeout = setTimeout(() => {
                setColorClass(props.defaultColor);
            }, 1000);
        }
    });

    onCleanup(() => clearTimeout(timeout));

    return (
        <div class={`text-2xl font-bold transition-colors duration-300 ${colorClass()}`}>
            {props.val != null ? props.format(props.val) : '--'}
        </div>
    );
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const TradeTicket = (props) => {
    const market = () => props.market?.();

    const [side, setSide] = createSignal("YES"); // YES | NO
    const [stakeShares, setStakeShares] = createSignal("");
    const [submitting, setSubmitting] = createSignal(false);
    const [error, setError] = createSignal(null);
    const [lastFill, setLastFill] = createSignal(null);

    const marketProb = createMemo(() => {
        const p = Number(market()?.market_prob);
        return Number.isFinite(p) ? p : 0.5;
    });

    const priceYes = createMemo(() => marketProb());
    const priceNo = createMemo(() => 1 - marketProb());
    const selectedPrice = createMemo(() => (side() === "YES" ? priceYes() : priceNo()));

    const sharesNum = createMemo(() => {
        const n = Number(stakeShares());
        return Number.isFinite(n) && n > 0 ? n : 0;
    });

    // Per spec: estimated cost = shares * price (YES price = p, NO price = 1-p)
    const estimatedCost = createMemo(() => sharesNum() * selectedPrice());

    const canTrade = createMemo(() => {
        if (submitting()) return false;
        if (!market()?.id) return false;
        if (sharesNum() <= 0) return false;
        const stake = estimatedCost();
        if (!Number.isFinite(stake) || stake < 0.01 || stake > 1_000_000) return false;
        const p = marketProb();
        if (side() === "YES") return p < 0.999;
        return p > 0.001;
    });

    const submit = async (e) => {
        e?.preventDefault();
        setError(null);
        setLastFill(null);

        const m = market();
        if (!m?.id) return setError("No market selected.");

        const shares = sharesNum();
        if (shares <= 0) return setError("Enter a positive stake amount.");

        const p = marketProb();
        if (side() === "YES" && p >= 0.999) return setError("YES is already priced near 1.00.");
        if (side() === "NO" && p <= 0.001) return setError("NO is already priced near 1.00.");

        // Backend expects: stake (RP) + target_prob. target_prob is only used to pick direction (>p => YES, else NO).
        const stake = shares * selectedPrice();
        if (!Number.isFinite(stake) || stake < 0.01) return setError("Estimated cost must be at least 0.01 RP.");
        if (stake > 1_000_000) return setError("Estimated cost exceeds the 1,000,000 RP max per trade.");
        const eps = 0.001;
        const target_prob =
            side() === "YES" ? clamp(p + eps, 0.001, 0.999) : clamp(p - eps, 0.001, 0.999);

        setSubmitting(true);
        try {
            const resp = await fetch(`/api/events/${m.id}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${(await import('../../services/tokenService')).getToken()}` },
                body: JSON.stringify({ stake, target_prob })
            });
            if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw { data: d, message: d.message || 'Trade failed' }; }
            const result = await resp.json();
            setLastFill(result);
            setStakeShares("");
        } catch (err) {
            setError(err?.data?.message || err?.message || "Trade failed.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <form onSubmit={submit} class="bg-bb-panel border border-bb-border p-3">
            <div class="flex items-start justify-between gap-3 mb-3">
                <div>
                    <div class="text-xs text-bb-muted uppercase">Trade Ticket</div>
                    <div class="text-xxs text-bb-muted font-mono">
                        YES @ {(priceYes() * 100).toFixed(1)}% | NO @ {(priceNo() * 100).toFixed(1)}%
                    </div>
                </div>
                <div class="text-xxs text-bb-muted font-mono text-right">
                    <div>Est. cost uses current price.</div>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-2 mb-3">
                <button
                    type="button"
                    onClick={() => setSide("YES")}
                    class={
                        side() === "YES"
                            ? "bg-market-up/30 text-market-up border border-market-up py-2 font-bold uppercase text-sm"
                            : "bg-market-up/10 text-market-up border border-bb-border hover:bg-market-up/20 py-2 font-bold uppercase text-sm"
                    }
                >
                    BUY YES
                </button>
                <button
                    type="button"
                    onClick={() => setSide("NO")}
                    class={
                        side() === "NO"
                            ? "bg-market-down/30 text-market-down border border-market-down py-2 font-bold uppercase text-sm"
                            : "bg-market-down/10 text-market-down border border-bb-border hover:bg-market-down/20 py-2 font-bold uppercase text-sm"
                    }
                >
                    BUY NO
                </button>
            </div>

            <div class="grid grid-cols-2 gap-3 items-end mb-3">
                <label class="block">
                    <div class="text-xxs text-bb-muted uppercase mb-1">Stake Amount</div>
                    <input
                        type="number"
                        inputmode="decimal"
                        min="0"
                        step="0.01"
                        value={stakeShares()}
                        onInput={(e) => setStakeShares(e.currentTarget.value)}
                        placeholder="e.g. 10"
                        class="w-full bg-black border border-bb-border px-2 py-2 text-bb-text"
                    />
                </label>
                <div class="bg-black border border-bb-border px-2 py-2">
                    <div class="text-xxs text-bb-muted uppercase">Estimated Cost (RP)</div>
                    <div class="text-sm font-bold text-bb-text">
                        {Number.isFinite(estimatedCost()) ? estimatedCost().toFixed(4) : "--"}
                    </div>
                </div>
            </div>

            <button
                type="submit"
                disabled={!canTrade()}
                class="w-full bg-bb-accent/20 text-bb-accent border border-bb-accent hover:bg-bb-accent/30 disabled:opacity-50 disabled:cursor-not-allowed py-2 font-bold uppercase text-sm"
            >
                {submitting() ? "PLACING..." : "PLACE TRADE"}
            </button>

            <Show when={error()}>
                <div class="mt-2 text-xs text-market-down">{error()}</div>
            </Show>

            <Show when={lastFill()}>
                <div class="mt-2 text-xs text-bb-muted">
                    Filled: +{Number(lastFill().shares_acquired).toFixed(4)} {lastFill().share_type} shares. New prob:{" "}
                    {(Number(lastFill().new_prob) * 100).toFixed(2)}%
                </div>
            </Show>
        </form>
    );
};

export const MarketDetail = () => {
    const market = marketStore.getSelectedMarket;

    return (
        <div class="h-full flex flex-col p-3 md:p-4 font-mono overflow-auto custom-scrollbar">
            <Show when={market()} fallback={<div class="text-center text-bb-muted mt-20">SELECT A MARKET DATA STREAM</div>}>
                <div class="md:hidden mb-3 flex items-center justify-between gap-2">
                    <button
                        type="button"
                        class="bg-bb-bg border border-bb-border text-bb-text px-2 py-1 text-xs hover:bg-bb-border hover:text-bb-accent transition-colors"
                        onClick={() => marketStore.selectMarket(null)}
                    >
                        &lt; LIST
                    </button>
                    <div class="text-[10px] text-bb-muted uppercase truncate">MARKET DETAIL</div>
                </div>

                <div class="border-b border-bb-border pb-2 mb-4">
                    <h2 class="text-lg font-bold text-bb-accent mb-1">{market().title}</h2>
                    <div class="flex justify-between text-xs text-bb-muted">
                        <span>ID: {market().id}</span>
                        <span>CLOSE: {market().closing_date ? new Date(market().closing_date).toLocaleDateString() : 'N/A'}</span>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-4 mb-4">
                    <div class="bg-bb-panel border border-bb-border p-2">
                        <div class="text-xxs text-bb-muted uppercase">Current Probability</div>
                        <FlashValueBig
                            val={market().market_prob}
                            prev={market().prev_market_prob}
                            format={(v) => `${(Number(v) * 100).toFixed(1)}%`}
                            defaultColor="text-market-up"
                        />
                    </div>
                    <div class="bg-bb-panel border border-bb-border p-2">
                        <div class="text-xxs text-bb-muted uppercase">Cumulative Stake</div>
                        <FlashValueBig
                            val={market().cumulative_stake}
                            prev={market().prev_cumulative_stake}
                            format={(v) => `$${Number(v).toFixed(2)}`}
                            defaultColor="text-bb-text"
                        />
                    </div>
                </div>

                <div class="mt-auto">
                    <TradeTicket market={market} />
                </div>
            </Show>
        </div>
    );
};
