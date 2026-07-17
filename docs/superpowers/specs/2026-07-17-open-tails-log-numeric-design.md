# Open-Tail + Log-Scaled Numeric Markets — Design

**Date:** 2026-07-17
**Status:** Approved (design discussion 2026-07-17; scope + tail-UI chosen by Justus)
**Predecessors:** `2026-07-14-numeric-markets-codex-consult.md` (§ "Log and open-bound questions"), `2026-07-14-numeric-markets-design.md`, shipped 50-bin linear numeric LMSR (2026-07-15, fast-follows 2026-07-16).

## Goal

Make log-scaled (`zero_point` set) and open-bounded (`open_lower_bound` /
`open_upper_bound`) Metaculus numeric questions seedable and tradeable.
Today only closed-range linear questions seed (~19% of live numeric
questions); this covers the remaining ~81%. One feature, both capabilities —
they share every seam (seeder filters, bin generation, resolution, frontend
axis).

## Architecture: transform-space binning

All internal math operates in Metaculus's internal coordinate **t ∈ [0,1]**
("unscaled location"). Nominal values (dollars, degrees, …) appear only at
the boundaries: stored bin bounds, resolution comparison, labels, axis ticks.
Linear markets use the identity-shaped linear map, so there is **one unified
code path** — no separate linear/log branches beyond the transform functions
themselves.

### The exact Metaculus transform

Source of truth: `Metaculus/metaculus` repo, `utils/the_math/formulas.py`
(`scaled_location_to_unscaled_location` / `unscaled_location_to_scaled_location`).
Do not approximate with plain `ln(x)`.

With `d = (range_max − zero_point) / (range_min − zero_point)` ("deriv_ratio"):

- **nominal → t** (`to_internal(x)`):
  - `zero_point` set:
    `t = ( ln((x − range_min)·(d − 1) + (range_max − range_min)) − ln(range_max − range_min) ) / ln(d)`
  - `zero_point` null: `t = (x − range_min) / (range_max − range_min)`
- **t → nominal** (`to_nominal(t)`):
  - `zero_point` set: `x = range_min + (range_max − range_min)·(d^t − 1)/(d − 1)`
  - `zero_point` null: `x = range_min + (range_max − range_min)·t`

**Validity guards** (seeder skips the market and counts it if violated):
`range_min`/`range_max` finite, `range_max > range_min`; if `zero_point` is
set: `zero_point` finite, `(range_min − zero_point)` and
`(range_max − zero_point)` nonzero with the same sign (so `d > 0`), and
`d ≠ 1` (within f64 tolerance), `ln(d)` finite.

### Outcome layout

- 50 inbound bins, equal width **in t** (`t_i = i/50`), bounds stored in
  `event_outcomes.lower_bound/upper_bound` in **nominal** values
  (`to_nominal(t_i)`); the last inbound bin's upper bound is set to exactly
  `range_max`, the first's lower to exactly `range_min` (no float drift).
  `outcome_key = bin_0 … bin_49`, `sort_order = 0..49` — identical to today.
- **Tail outcomes** only when the corresponding bound is open:
  - `tail_low`: `bucket_kind='lower_tail'`, `lower_bound=NULL`,
    `upper_bound=range_min`, `sort_order=50`.
  - `tail_high`: `bucket_kind='upper_tail'`, `lower_bound=range_max`,
    `upper_bound=NULL`, `sort_order=51` (50 if there is no lower tail).
  - Labels: `"< {range_min}"` / `"> {range_max}"` via the existing
    `format_bin_number` formatter (+ unit if present).
- `outcome_count = 50 + number_of_tails` (50, 51, or 52). Appending tails
  after the inbound bins keeps inbound q-vector indices identical to today.
- Initial state: uniform `prob = 1/outcome_count`, `q = 0` for every outcome;
  `events.market_prob = 1/outcome_count`.
- `b_numeric = NUMERIC_MAX_SUBSIDY_RP / ln(outcome_count)` — keeps the
  worst-case-loss bound exact for the enlarged outcome set.

### Resolution semantics (Metaculus bucket convention)

For resolved value `x` (both `lmsr_api::resolve_numeric_event` and
`resolution_sync::pick_winning_bin` — keep them mirrored):

| Condition | Winner |
|---|---|
| `x < range_min` | `tail_low` if present, else no-match (today's error/skip) |
| `x == range_min` | first inbound bin (`bin_0`) |
| `range_min < x < range_max` | inbound scan as today (`[lower, upper)`, last bin closed) |
| `x == range_max` | last inbound bin (`bin_49`) |
| `x > range_max` | `tail_high` if present, else no-match |

An open upper tail means `X > max`, not `X ≥ max`. Closed markets (no tails)
keep exactly today's behavior including the hard error on out-of-range values.

## Schema change (one migration)

```sql
ALTER TABLE event_outcomes
  ADD COLUMN bucket_kind TEXT NOT NULL DEFAULT 'inbound'
  CHECK (bucket_kind IN ('inbound', 'lower_tail', 'upper_tail'));
```

`numeric_market_config` already has every needed column (`zero_point`,
`open_lower_bound`, `open_upper_bound`, `transform`, `binning_version`); the
seeder starts writing real values: `transform = 'log'` when `zero_point` is
set else `'linear'`, `binning_version = 2` for newly seeded markets.
Existing rows (`binning_version = 1`, `transform = 'linear'`, closed) keep
working unchanged — the unified path reproduces their bins exactly. No data
migration.

## Engine changes

1. **New module `prediction-engine/src/numeric_transform.rs`**:
   `NumericTransform { range_min, range_max, zero_point: Option<f64> }` with
   `to_internal(&self, x: f64) -> f64`, `to_nominal(&self, t: f64) -> f64`,
   `validate(&self) -> Result<()>` (guards above), and
   `transformed_bin_edges(&self, bin_count) -> Vec<(f64, f64)>` (nominal
   bounds, exact endpoints). Property tests: round-trip `|to_internal(to_nominal(t)) − t| < 1e-9`,
   monotonicity, exact endpoint mapping, linear case ≡ current `linear_bins`
   edges.
2. **Seeder** (`market_import.rs::seed_numeric_bins_if_missing`): remove the
   `zero_point` and open-bound skip filters; validate via
   `NumericTransform::validate` (invalid → skip + count, as other skips);
   create tails per the layout above; write real config values.
3. **Quote/trade** (`lmsr_api.rs`): `validate_target` checks
   `target.len() == outcome_count` (already reads bin rows — derive count
   from the row count, not the config's `bin_count`, which stays 50 =
   inbound-only). No other math changes: the LMSR core is outcome-agnostic.
4. **Resolution**: implement the semantics table (both call sites), driven by
   `bucket_kind` + config range, not by null-bound sniffing.
5. **Market-state API** (`get_market_state`): add
   `"numeric_config": { transform, zero_point, range_min, range_max, open_lower_bound, open_upper_bound, unit }`
   (null for non-numeric events) and include `bucket_kind` in each outcome row.
6. **Settlement / invariant / basis / OCC: zero changes.** Tails are
   ordinary outcomes in `user_outcome_shares` + `numeric_position_basis`.

## Frontend changes

1. **`utils/distributionMath.js` → t-space**: `fitDistribution` takes the
   transform (from `numeric_config`), maps P10/P50/P90 handle values to t,
   fits the split-normal **in t**, integrates the CDF over the 50 equal-width
   t-bins. Out-of-range mass is handled per side: below-t=0 mass goes to
   `tail_low` if it exists, above-t=1 mass to `tail_high` if it exists; mass
   on a **closed** side is dropped. After assignment, the whole vector is
   renormalized to sum to 1 (for fully closed markets this reduces to
   exactly today's drop + renormalize). Target array ordering = outcomes
   ordered by `sort_order` ASC (inbound 0..49, then tails).
2. **`DistributionMarketCard.jsx`**:
   - Read `numeric_config` from market state instead of deriving range from
     the first/last bin bounds; keep the derivation as fallback for older
     cached responses.
   - **x-axis in t-space**: every bin renders equal width (log markets
     included). Tick labels: ~5 nice nominal values (1–2–5 progression in
     nominal space for log markets, current behavior for linear) mapped
     through `to_internal` for placement.
   - Handles are dragged in t-space; displayed values are nominal
     (`to_nominal`), formatted with the existing `fmt` + unit.
   - Initial handle positions: quantiles computed in t-space (bins are
     equal-width there), then displayed nominal.
   - **Edge bars** (chosen UI): a slim bar at each open end, visually
     distinct from inbound steps (separated by a small gap), labeled
     `< {range_min}` / `> {range_max}` with the tail's current probability;
     the post-trade preview shows the tail's post probability the same way.
   - Filter tails out of the step-curve path (inbound bins only).
3. **`MyPositions.jsx`**: no change (bins counted generically).

## Error handling

- Seeder: any transform-validation failure, or `d` degenerate → skip market,
  increment the existing skip counters (visible in `external_import_runs`).
- Engine quote/trade: target length mismatch → existing 4xx path.
- Resolution without a needed tail (closed market, out-of-range value):
  today's error (API) / warn-and-skip (sync) — unchanged.
- Frontend: if `numeric_config` is missing (stale bundle/backend), fall back
  to linear behavior derived from bin bounds — i.e., exactly today's
  rendering; log markets without config would look linear but stay tradeable
  and correct (targets are integrated in whatever space the FE used; the
  engine only sees a mass vector). This fallback is a degraded-display mode,
  not a correctness risk.

## Testing

- **Rust unit/property**: transform round-trip, monotonicity, endpoints,
  linear-equivalence; bin-edge generation for a real log question's
  parameters (e.g. range 1–10000, zero_point 0).
- **Rust integration** (extend `integration_tests.rs` schema stand-ins with
  `bucket_kind`): seeding a log+open market creates 52 rows with correct
  kinds/bounds/labels and config values; resolution: `x < min` pays
  `tail_low`, `x == min` pays `bin_0`, `x == max` pays `bin_49`,
  `x > max` pays `tail_high`; closed market keeps the out-of-range error;
  settlement pays a tail winner and clears positions (mirror of the existing
  settlement test); quote/trade round-trip on a 52-outcome market.
- **Frontend unit**: t-space fit produces tail mass for wide handle spreads;
  closed-market renormalization unchanged; tick generation for a log range.
- **E2E** (`numeric-market.spec.js` pattern): seed a log + double-open
  fixture market directly in the DB, assert edge bars render with labels,
  trade lands (position appears, curve changes), sell clears; existing
  linear-market specs stay green (regression).
- **Gates**: engine full suite, E2E sweep, CI, then engine rebuild + one
  real re-import sync on prod and a spot-check of a freshly seeded log
  market at intellacc.de.

## Out of scope

- Backend admin/manual bucket creation (`eventOutcomes.js`) stays
  closed-linear-only.
- Re-binning the 15 live linear markets (they stay `binning_version 1`).
- Metaculus `date` / `discrete` question types.
- Adaptive bin counts, partial rebalancing (future items from the consult).
- Backfilling deep history (existing `IMPORT_METACULUS_LIMIT` mechanism is
  enough).

## Rollout

Migration auto-runs on backend restart; engine rebuild deploys the seeder;
the next `POST /imports/sync/metaculus` seeds newly eligible questions
(existing imported-but-unconfigured numeric events get picked up by the same
`seed_outcomes_if_missing` pass — no manual backfill step). Frontend restart
last. Feature is data-driven — no flag needed; markets without tails/log
config behave exactly as before.
