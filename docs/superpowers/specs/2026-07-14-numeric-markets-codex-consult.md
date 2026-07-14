I’ll trace the live implementation and its invariants first, then give you an architecture recommendation grounded in those exact constraints. I’m also invoking Claude for an independent architecture/code-review pass, as required by this repository’s consulting guidance.
The code confirms the core idea is viable, but it also exposes a key distinction: a 100-bin market is mathematically straightforward, while treating a distribution edit as 100 independent existing trades would break the intended atomicity and distort ledger/history semantics. I’m checking settlement and accounting now, because those are the highest-risk constraints.
## Verdict

Your hypothesis is basically right, with three changes:

1. Use a discretized LMSR, but start with roughly **50–64 bins**, not 100 by default.
2. Add a genuine **vector trade primitive**. Do not implement bundles as repeated calls to the current single-outcome endpoint.
3. Treat the distribution editor as specifying a **desired market distribution**, not as a literal Kelly portfolio. “Optimal” requires an explicit utility and bankroll model.

Dense-bin LMSR is the best practical fit for Intellacc’s bounded-loss and ledger constraints. Parametric and scoring-rule alternatives would require substantially more novel accounting while supporting fewer distribution shapes.

## 1. Market-maker architecture

Keep categorical LMSR:

\[
C(\mathbf q)=b\log\sum_i e^{q_i/b},\qquad
p_i=\frac{e^{q_i/b}}{\sum_j e^{q_j/b}}
\]

Each bin is an Arrow security paying 1 RP when its interval contains the resolution.

Why this construction wins here:

- Bounded market-maker loss is explicit.
- Every position has an unambiguous current liquidation value.
- Existing settlement and position concepts remain applicable.
- Multimodal, skewed and irregular distributions are supported.
- The existing multi-outcome implementation already has stable log-sum-exp probability computation in [lmsr_multi_core.rs](/var/opt/docker/intellacc.com/prediction-engine/src/lmsr_multi_core.rs:53).
- Numeric settlement already selects a winning interval in [lmsr_api.rs](/var/opt/docker/intellacc.com/prediction-engine/src/lmsr_api.rs:1239).

I would reject:

- Parametric normal/lognormal LMSR: lower-dimensional, but users cannot express multimodality, point masses or asymmetric tails. The loss bound and liquidation logic become model-specific.
- Continuous CFMMs: possible, but inventory/collateral accounting and bounded support would be a new subsystem.
- Direct proper-scoring payments: good for forecasts, poor for sellable financial positions. It would coexist better as a forecasting feature than replace LMSR trading.
- A collection of threshold markets \(P(X\le x)\): intuitive as a CDF, but enforcing monotonicity and preventing arbitrage across 50–100 coupled binary markets is harder than one categorical LMSR.

Call the implementation “discretized continuous” internally. Settlement is still discontinuous at bin boundaries.

The new core primitive should look conceptually like:

```rust
apply_vector(delta_q: &[f64]) -> Result<cost_delta>
```

It should compute one cost difference, validate the entire resulting vector, and commit it atomically. The current core only buys or sells one coordinate at a time [lmsr_multi_core.rs](/var/opt/docker/intellacc.com/prediction-engine/src/lmsr_multi_core.rs:33).

## 2. Bin count, liquidity and bounds

I recommend **50 inbound bins**, optionally plus one lower-tail and one upper-tail outcome.

That gives approximately 12 px per bin in a 600 px chart, supports a clean 0–10 example with width 0.2, and avoids pretending to have more resolution than many source questions justify. Allow 32–64 based on the question’s meaningful precision, but make the bin layout immutable after trading begins.

For uniform initialization, maximum subsidy is:

\[
L=b\ln n
\]

With the current default \(b=5000\):

| Outcomes | Maximum loss |
|---:|---:|
| 2 | 3,466 RP |
| 50 | 19,560 RP |
| 64 | 20,794 RP |
| 100 | 23,026 RP |

So reusing `b=5000` would increase subsidy by roughly sixfold. To preserve the current binary subsidy at 50 outcomes:

\[
b_{\text{numeric}}=5000\frac{\ln2}{\ln50}\approx 886
\]

That is my suggested initial value if today’s binary subsidy is the intended budget. If you want binary-like price depth instead, retain \(b=5000\) and explicitly accept the larger loss bound. Make this a policy decision expressed as `max_subsidy_rp`, then derive \(b\), rather than silently copying `liquidity_b`.

For a nonuniform initial prior \(p^0\), the loss bound is:

\[
L=b\ln\frac{1}{\min_i p^0_i}
\]

Tiny initial tail probabilities therefore increase the bound.

Numerically, 50–100 outcomes are harmless for `f64`. The relevant safeguards are:

- Floor submitted target masses, for example at \(10^{-9}\), then renormalize.
- Reject or clamp market log-odds spans beyond roughly \(40b\).
- Compute vector cost directly from the current probabilities and deltas where possible, avoiding subtraction of two very large absolute costs.
- Round the total bundle cost once to `LEDGER_SCALE`, never each bin separately. The scale is defined in [lmsr_core.rs](/var/opt/docker/intellacc.com/prediction-engine/src/lmsr_core.rs:8).

### Log and open-bound questions

The import pipeline currently does not capture the necessary metadata. `MetaculusQuestion` only deserializes type, title, status and description, and imported numeric questions receive no outcomes [metaculus.rs](/var/opt/docker/intellacc.com/prediction-engine/src/metaculus.rs:25). Consequently, `seed_outcomes_if_missing` exits because `market.outcomes` is empty [market_import.rs](/var/opt/docker/intellacc.com/prediction-engine/src/market_import.rs:402).

Import and preserve:

- `range_min`
- `range_max`
- `zero_point`
- `open_lower_bound`
- `open_upper_bound`
- source scaling version

Metaculus defines `zero_point = null` as linear scaling and provides a specific logarithmic coordinate transform otherwise. It also models below-range and above-range probability separately for open bounds. Follow that source transform exactly rather than approximating it with ordinary `ln(x)` binning. [Metaculus API documentation](https://www.metaculus.com/api/)

Create equal-width bins in the transformed/internal coordinate. Display probability density in nominal coordinates as \(p_i/\Delta x_i\), because log bins have unequal raw widths.

Use explicit lower-tail and upper-tail outcomes for open bounds. The existing resolver understands null bounds, but backend normalization currently rejects buckets unless both bounds are finite [eventOutcomes.js](/var/opt/docker/intellacc.com/backend/src/utils/eventOutcomes.js:56). Also fix upper-bound equality semantics: an open upper tail should generally represent \(X>\text{max}\), not \(X\ge\text{max}\).

## 3. Bundle math

Let:

- \(p_i\) be current market probability mass
- \(u_i\) be the normalized user target mass
- \(b\) be liquidity

Define:

\[
d_i=b\log\frac{u_i}{p_i}
\]

A share vector producing exactly \(u\) is:

\[
\Delta q_i=d_i+a
\]

for any common constant \(a\). The minimum-cost buy-only representative is:

\[
\Delta q_i=d_i-\min_j d_j
\]

All components are then nonnegative. Its cost is:

\[
S_{\text{exact}}=-\min_i d_i
=b\max_i\log\frac{p_i}{u_i}
\]

If the budget is smaller, use an aggressiveness parameter \(\alpha\in[0,1]\):

\[
\Delta q_i(\alpha)
=\alpha(d_i-\min_jd_j)
\]

The resulting distribution is:

\[
p_i(\alpha)=
\frac{p_i^{1-\alpha}u_i^\alpha}
{\sum_j p_j^{1-\alpha}u_j^\alpha}
\]

Its cost is:

\[
S(\alpha)=
-\alpha\min_i d_i
+b\log\sum_i p_i^{1-\alpha}u_i^\alpha
\]

Solve for the largest \(\alpha\) whose rounded ledger cost does not exceed the user’s integer budget. This gives a clean, deterministic and testable “move the market toward my distribution” operation. If the budget exceeds \(S(1)\), stop at \(u\); buying extra complete sets merely locks risk-free capital.

This geometric path is a KL-barycenter projection. It is not Kelly.

True LMSR Kelly requires bankroll \(W\), existing payout vector \(h_i\), and solving:

\[
\max_{\Delta q}
\sum_i u_i\log\left(
W-K(\Delta q)+h_i+\Delta q_i
\right)
\]

subject to:

\[
\Delta q_i\ge-h_i
\]

where \(K(\Delta q)=C(q+\Delta q)-C(q)\). That is a numerical constrained optimization problem. I would not put it in v1.

For the first release, describe the budget control as “market influence” or “trade size”, not “fractional Kelly”.

## 4. Ledger and invariant sharp edges

The biggest risks are accounting semantics, not `f64`.

- Round one net \(\Delta C\). Rounding 100 leg costs independently can introduce up to roughly 50 micro-RP per bundle and makes results order-dependent.
- Bundle cost is not naturally attributable to individual bins. The existing `staked_ledger` is per outcome [multi-outcome schema](/var/opt/docker/intellacc.com/backend/migrations/20260322_add_multi_outcome_lmsr_schema.sql:32), but a vector trade has one joint cost. Do not invent per-bin marginal costs based on processing order.
- Accept signed vector deltas for rebalance/sale, but enforce `holding_i + delta_i >= 0` with a tolerance and canonicalize near-zero results to exactly zero.
- Quote and execution need `market_version` plus `max_cost_ledger`. The event row lock already serializes market updates [lmsr_api.rs](/var/opt/docker/intellacc.com/prediction-engine/src/lmsr_api.rs:516), but it does not protect users from a stale quote.
- Persist all 50–100 state changes with one bulk `UNNEST`/`VALUES` statement. The current paths issue one upsert per outcome [lmsr_api.rs](/var/opt/docker/intellacc.com/prediction-engine/src/lmsr_api.rs:597).
- The current multi-outcome buy returns the requested floating stake rather than recomputing the achieved cost after bisection [lmsr_multi_core.rs](/var/opt/docker/intellacc.com/prediction-engine/src/lmsr_multi_core.rs:40). A vector executor should calculate and ledger-round the actual cost directly.
- Full liquidation should sell one vector atomically. Do not call `sell-outcome` 50 times.
- Settlement should group all rows by user, sum total staked ledger exactly, round the winning-bin payout once, and update the user once.

Most importantly, the existing invariant checkers are still binary-centric. The staked invariant only sums `user_shares`, excluding `user_outcome_shares` [lmsr_api.rs](/var/opt/docker/intellacc.com/prediction-engine/src/lmsr_api.rs:1893). The post-resolution invariant likewise checks only `user_shares`. Those must be generalized before numeric trading launches.

Also, do not present normalized holdings as “the user’s belief curve”. Holdings include cost basis and potentially common complete-set exposure. Store the submitted target distribution separately if you want to display their belief.

## 5. UI

Do not start with freehand drawing. It is noisy, poor on touch devices and hard to make accessible.

Use:

- A market density area.
- A user target line.
- Three primary horizontal handles: low, center, high.
- Copy such as: “80% chance between 3.2 and 6.1” and “most likely around 4.7”.
- Presets: narrow, medium, wide.
- Optional skew control: left, symmetric, right.
- A budget slider with an after-trade preview.
- Numeric inputs corresponding to every handle for keyboard/mobile accessibility.

Fit a split-normal or smooth piecewise CDF to low/median/high, then integrate that CDF over the actual bin edges to obtain \(u_i\). Never sample PDF height at bin centers and normalize it, especially with log-scaled bins.

An advanced editor can later expose five quantiles, such as P5/P25/P50/P75/P95. Metaculus itself documents percentile-to-CDF generation, which is a good interaction model for nonparametric forecasts. [Metaculus API documentation](https://www.metaculus.com/api/)

`MarketDetailView` currently sends both numeric and multiple-choice markets to the same `OutcomeMarketCard` [MarketDetailView.jsx](/var/opt/docker/intellacc.com/frontend-solid/src/components/predictions/MarketDetailView.jsx:211). Split that dispatch into `DistributionMarketCard` for numeric markets. The current outcome list is inherently unsuitable for 50 outcomes [OutcomeMarketCard.jsx](/var/opt/docker/intellacc.com/frontend-solid/src/components/predictions/OutcomeMarketCard.jsx:317).

## 6. Schema and coexistence

Keep `event_outcomes` and `event_outcome_states` as the canonical bin and LMSR state tables. They already contain the required bounds and state columns.

Add:

```text
numeric_market_config
  event_id
  range_min
  range_max
  zero_point
  open_lower_bound
  open_upper_bound
  bin_count
  transform
  binning_version

distribution_trades
  id
  user_id
  event_id
  total_cost_ledger
  target_distribution_json
  alpha
  pre_market_version
  post_market_version
  hold_until
  created_at

distribution_trade_legs
  trade_id
  outcome_id
  shares_delta
```

Also add a market-level numeric position/cost-basis row, rather than assigning the joint bundle cost independently to 50 outcome rows.

Consider a `bucket_kind` of `inbound`, `lower_tail`, or `upper_tail`, or equivalent inclusion flags. Raw nullable bounds alone cannot express all exact boundary semantics safely.

Multiple-choice markets should continue using the existing endpoint and UI. Numeric markets should use the vector endpoint exclusively after migration.

## 7. Smallest shippable slice

I would ship this sequence:

1. Support only bounded, linear numeric questions with trustworthy finite metadata.
2. Generate 50 immutable bins and uniform initial mass.
3. Add vector quote and execute endpoints with one ledger debit and one atomic transaction.
4. Add the low/center/high distribution editor and before/after curve.
5. Support “sell entire numeric position” atomically. Defer arbitrary partial rebalance, but positions are genuinely liquid from day one.
6. Settle into one winning bin using the existing categorical payout model.
7. Add vector property tests:
   - probabilities finite and sum to one
   - quoted cost equals executed ledger cost
   - exact bundle followed by exact sale at unchanged state is ledger-neutral
   - no permutation dependence
   - no user holding becomes negative
   - concurrent trades serialize correctly
   - resolution clears all numeric positions and staked ledger exactly
8. Then add partial rebalancing, log scaling, open tails and adaptive bin counts.

That slice will feel continuous because users manipulate and trade a smooth curve, while the financial and settlement machinery remains a bounded-loss categorical LMSR underneath.