import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { api } from "../../services/api";
import { marketStore } from "../../store/marketStore";
import { getToken } from "../../services/tokenService";
import { deriveTradeSide } from "../../lib/tradeBelief";
import {
    KELLY_FRACTIONS,
    fullKellyFromSuggestion,
    stakeForFraction,
    beliefTrackGradient,
} from "../../lib/kellyStake";
import { kellyFraction, setKellyFractionPreference } from "../../services/kellyPreference";

const KELLY_FRACTION_LABELS = { 0.25: "1/4", 0.5: "1/2", 1: "1x" };
// Terminal palette: market-down / white / market-up (see tailwind theme).
const BELIEF_TRACK_COLORS = { no: "#FF3D00", mid: "#ffffff", yes: "#00FF41" };
import DistributionMarketCard from "../predictions/DistributionMarketCard";
import OutcomeMarketCard from "../predictions/OutcomeMarketCard";
import { createPhoneGate } from "../../services/verificationGate";

// Same market-type gates as the van skin's MarketDetailView: numeric events
// trade a full distribution, multiple_choice trades per-outcome, and only
// true binary markets get the YES/NO ticket against market_prob.
const isNumeric = (m) => m?.event_type === 'numeric';
const isMultipleChoice = (m) => m?.event_type === 'multiple_choice';

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

    const [stakeShares, setStakeShares] = createSignal("");
    const [submitting, setSubmitting] = createSignal(false);
    const [error, setError] = createSignal(null);
    const [lastFill, setLastFill] = createSignal(null);
    const [belief, setBelief] = createSignal(0.5);
    // Full Kelly (RP) for the current belief plus the balance it was sized
    // against; the shares field auto-fills at the remembered fraction of it.
    const [fullKelly, setFullKelly] = createSignal(0);
    const [kellyBalance, setKellyBalance] = createSignal(0);
    const [stakeTouched, setStakeTouched] = createSignal(false);
    const phoneGate = createPhoneGate();
    let kellyTimeout;

    const marketProb = createMemo(() => {
        const p = Number(market()?.market_prob);
        return Number.isFinite(p) ? p : 0.5;
    });

    // Direction is derived from the stated belief vs. the market price;
    // null when the belief sits on the market (no edge, nothing to buy).
    const side = createMemo(() => {
        const s = deriveTradeSide(belief(), marketProb());
        return s ? s.toUpperCase() : null;
    });

    // Start the belief at the market price whenever a new market is shown:
    // the neutral no-trade state, so any movement is explicit disagreement.
    let beliefInitId = null;
    createEffect(() => {
        const id = market()?.id;
        if (id != null && id !== beliefInitId) {
            beliefInitId = id;
            setBelief(marketProb());
            setStakeTouched(false);
            setStakeShares("");
        }
    });

    const getUserId = () => {
        try {
            const token = getToken();
            if (!token) return null;
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.id || payload.userId || null;
        } catch { return null; }
    };

    const getKellySuggestion = async (beliefVal) => {
        const m = market();
        if (!m?.id) return;
        const userId = getUserId();
        if (!userId) return;
        try {
            const data = await api.events.getKelly(m.id, beliefVal);
            setFullKelly(fullKellyFromSuggestion(data));
            const balance = Number(data?.balance);
            setKellyBalance(Number.isFinite(balance) ? balance : 0);
        } catch (err) {
            // Sizing is a helper, never a gate: without it the field stays empty.
            if (err?.status !== 403) console.error('[Kelly] API error:', err);
            setFullKelly(0);
        }
    };

    const handleBeliefChange = (val) => {
        setBelief(val);
        clearTimeout(kellyTimeout);
        kellyTimeout = setTimeout(() => getKellySuggestion(val), 300);
    };

    // Fetch initial Kelly on market change
    createEffect(() => {
        if (market()?.id) {
            getKellySuggestion(belief());
        }
    });

    onCleanup(() => clearTimeout(kellyTimeout));

    const priceYes = createMemo(() => marketProb());
    const priceNo = createMemo(() => 1 - marketProb());
    const selectedPrice = createMemo(() => (side() === "NO" ? priceNo() : priceYes()));

    // Auto-fill: the Kelly stake is in RP, the ticket trades shares, so
    // convert at the current price of the derived side.
    const suggestedShares = () => {
        const rp = Number(stakeForFraction(fullKelly(), kellyFraction(), kellyBalance()));
        const price = selectedPrice();
        if (!(rp > 0) || !(price > 0)) return "";
        return (rp / price).toFixed(2);
    };
    createEffect(() => {
        const next = suggestedShares();
        if (untrack(stakeTouched)) return;
        setStakeShares(next);
    });
    const chooseFraction = (fraction) => {
        void setKellyFractionPreference(fraction);
        setStakeTouched(false);
        setStakeShares(suggestedShares());
    };
    const handleStakeInput = (raw) => {
        setStakeShares(raw);
        setStakeTouched(String(raw).trim() !== "");
    };


    const sharesNum = createMemo(() => {
        const n = Number(stakeShares());
        return Number.isFinite(n) && n > 0 ? n : 0;
    });

    // Per spec: estimated cost = shares * price (YES price = p, NO price = 1-p)
    const estimatedCost = createMemo(() => sharesNum() * selectedPrice());

    const canTrade = createMemo(() => {
        if (submitting()) return false;
        if (!market()?.id) return false;
        if (!side()) return false;
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

        if (!side()) return setError("Move your belief away from the market price to trade.");
        const p = marketProb();
        if (side() === "YES" && p >= 0.999) return setError("YES is already priced near 1.00.");
        if (side() === "NO" && p <= 0.001) return setError("NO is already priced near 1.00.");

        // Backend expects: stake (RP) + target_prob. The engine picks the side
        // from target_prob vs. the fresh price inside its transaction; sending
        // the stated belief keeps the side race-correct AND records the belief
        // on the market_updates row for calibration.
        const stake = shares * selectedPrice();
        if (!Number.isFinite(stake) || stake < 0.01) return setError("Estimated cost must be at least 0.01 RP.");
        if (stake > 1_000_000) return setError("Estimated cost exceeds the 1,000,000 RP max per trade.");
        const target_prob = clamp(belief(), 0.001, 0.999);

        setSubmitting(true);
        try {
            const result = await api.events.update(m.id, { stake, target_prob });
            setLastFill(result);
            window.dispatchEvent(new CustomEvent('rp-balance-refresh'));
            setStakeShares("");
            setStakeTouched(false);
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

            <Show when={phoneGate.needsPhone()}>
                <div data-testid="ticket-phone-gate" class="mb-3 p-2 border border-yellow-500/50 bg-yellow-500/10 text-yellow-400 text-xs font-mono flex items-center justify-between gap-2">
                    <span>PHONE VERIFICATION REQUIRED // TO TRADE</span>
                    <a href="#settings" class="px-2 py-0.5 border border-yellow-500 text-yellow-400 hover:bg-yellow-500/20 whitespace-nowrap uppercase">Verify</a>
                </div>
            </Show>

            <div class="mb-3">
                <Show
                    when={side()}
                    fallback={
                        <div class="border border-bb-border text-bb-muted py-2 text-center uppercase text-xs">
                            Market agrees with you — move the belief slider to trade
                        </div>
                    }
                >
                    <div
                        class={
                            side() === "YES"
                                ? "bg-market-up/30 text-market-up border border-market-up py-2 font-bold uppercase text-sm text-center"
                                : "bg-market-down/30 text-market-down border border-market-down py-2 font-bold uppercase text-sm text-center"
                        }
                    >
                        {`BUYS ${side()}`}
                    </div>
                </Show>
            </div>

            {/* Belief Slider */}
            <div class="mb-3">
                <div class="flex justify-between text-xxs text-bb-muted uppercase mb-1">
                    <span>Your Belief</span>
                    <span class="text-bb-accent">{(belief() * 100).toFixed(0)}%</span>
                </div>
                <input
                    type="range"
                    min="0.01"
                    max="0.99"
                    step="0.01"
                    value={belief()}
                    onInput={(e) => handleBeliefChange(parseFloat(e.currentTarget.value))}
                    style={{ background: beliefTrackGradient(marketProb(), BELIEF_TRACK_COLORS) }}
                    aria-label="Your belief probability"
                    class="belief-slider terminal-belief-slider w-full touch-none"
                />
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
                        onInput={(e) => handleStakeInput(e.currentTarget.value)}
                        placeholder="e.g. 10"
                        class="w-full bg-black border border-bb-border px-2 py-2 text-bb-text"
                    />
                    <div class="flex items-center gap-1 mt-1 text-xxs font-mono" role="group" aria-label="Stake size as a fraction of Kelly">
                        <span class="text-bb-muted uppercase mr-1">Kelly</span>
                        <For each={KELLY_FRACTIONS}>
                            {(fraction) => (
                                <button
                                    type="button"
                                    data-testid={`kelly-fraction-${fraction}`}
                                    disabled={!side() || !(fullKelly() > 0)}
                                    aria-pressed={!stakeTouched() && kellyFraction() === fraction}
                                    onClick={() => chooseFraction(fraction)}
                                    class={`px-1.5 py-0.5 border uppercase font-bold disabled:opacity-40 ${
                                        !stakeTouched() && kellyFraction() === fraction
                                            ? "border-bb-accent bg-bb-accent/20 text-bb-accent"
                                            : "border-bb-border text-bb-muted hover:border-bb-accent/60"
                                    }`}
                                >
                                    {KELLY_FRACTION_LABELS[fraction]}
                                </button>
                            )}
                        </For>
                    </div>
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

    // After an embedded numeric/outcome trade, pull the row's market_prob /
    // cumulative_stake fresh from the server so the readouts above the card
    // update immediately (binary trades get this via the socket tick).
    const handleTradeRefresh = () => {
        const id = market()?.id;
        if (id != null) void marketStore.refreshMarket(id);
    };

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
                    <h2 data-testid="market-detail-title" class="text-lg font-bold text-bb-accent mb-1">{market().title}</h2>
                    <div class="flex justify-between text-xs text-bb-muted">
                        <span>ID: {market().id}</span>
                        <span>CLOSE: {market().closing_date ? new Date(market().closing_date).toLocaleDateString() : 'N/A'}</span>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-4 mb-4">
                    {/* A single "probability" is meaningless for a numeric market
                        (the distribution below is the price); show the type tag
                        instead of a misleading market_prob readout. */}
                    <Show
                        when={!isNumeric(market())}
                        fallback={
                            <div class="bg-bb-panel border border-bb-border p-2">
                                <div class="text-xxs text-bb-muted uppercase">Market Type</div>
                                <div class="text-2xl font-bold text-market-neutral">NUMERIC</div>
                            </div>
                        }
                    >
                        <div class="bg-bb-panel border border-bb-border p-2">
                            <div class="text-xxs text-bb-muted uppercase">Current Probability</div>
                            <FlashValueBig
                                val={market().market_prob}
                                prev={market().prev_market_prob}
                                format={(v) => `${(Number(v) * 100).toFixed(1)}%`}
                                defaultColor="text-market-up"
                            />
                        </div>
                    </Show>
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

                {/* Trade UI by market type, mirroring the van skin's
                    MarketDetailView: numeric -> distribution trading,
                    multiple_choice -> per-outcome trading, binary -> ticket.
                    The van cards are reused as-is inside a .bb-embed wrapper
                    whose scoped CSS (styles.css) restyles them to the
                    terminal palette without touching the van skin. */}
                <Show
                    when={isNumeric(market())}
                    fallback={
                        <Show
                            when={isMultipleChoice(market())}
                            fallback={
                                <div class="mt-auto">
                                    <TradeTicket market={market} />
                                </div>
                            }
                        >
                            <div class="bb-embed" data-testid="terminal-outcome-embed">
                                <OutcomeMarketCard
                                    event={market()}
                                    onTrade={handleTradeRefresh}
                                    hideTitle={true}
                                />
                            </div>
                        </Show>
                    }
                >
                    <div class="bb-embed" data-testid="terminal-distribution-embed">
                        <DistributionMarketCard
                            event={market()}
                            onTrade={handleTradeRefresh}
                            hideTitle={true}
                        />
                    </div>
                </Show>
            </Show>
        </div>
    );
};
