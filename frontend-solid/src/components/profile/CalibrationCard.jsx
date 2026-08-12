import { createEffect, createSignal, For, Show } from 'solid-js';
import { api } from '../../services/api';

// Reliability diagram over the user's stated beliefs (belief_prob, recorded
// per binary trade since 2026-08-12) on resolved markets. One point per
// bucket: mean stated P(YES) vs. how often YES actually happened. Monochrome
// on purpose — a single series needs no hue, and ink tokens keep it legible
// in every skin and theme.

// Plot geometry (viewBox units)
const SIZE = 260;
const PAD_LEFT = 40;
const PAD_BOTTOM = 36;
const PAD_TOP = 14;
const PAD_RIGHT = 14;
const PLOT_W = SIZE - PAD_LEFT - PAD_RIGHT;
const PLOT_H = SIZE - PAD_TOP - PAD_BOTTOM;

const xFor = (p) => PAD_LEFT + p * PLOT_W;
const yFor = (p) => PAD_TOP + (1 - p) * PLOT_H;

const pct = (v) => `${Math.round(v * 100)}%`;

export default function CalibrationCard(props) {
  const [data, setData] = createSignal(null);
  const [loading, setLoading] = createSignal(false);

  let lastLoadedId = null;
  createEffect(() => {
    const id = props.userId?.();
    if (!id || id === lastLoadedId) return;
    lastLoadedId = id;
    setLoading(true);
    api.users.getCalibration(id)
      .then((res) => setData(res))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  });

  const points = () => (data()?.buckets || []).filter((b) => b.n > 0);

  const linePath = () =>
    points()
      .map((b, i) => `${i === 0 ? 'M' : 'L'}${xFor(b.mean_belief).toFixed(1)},${yFor(b.observed).toFixed(1)}`)
      .join(' ');

  return (
    <div class="calibration-section">
      <h4>Calibration</h4>
      <Show when={!loading()} fallback={<p class="calibration-note">Loading calibration...</p>}>
        <Show
          when={data() && data().n > 0}
          fallback={
            <p class="calibration-note">
              No resolved predictions with recorded beliefs yet. State your
              probability with the belief slider when trading — once those
              markets resolve, your calibration curve appears here.
            </p>
          }
        >
          <div class="calibration-chart-row">
            <svg
              class="calibration-chart"
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              role="img"
              aria-label={`Calibration chart: ${data().n} resolved predictions, Brier score ${data().brier.toFixed(3)}`}
            >
              {/* Grid + ticks at 0 / 50 / 100 */}
              <For each={[0, 0.5, 1]}>
                {(t) => (
                  <>
                    <line
                      x1={xFor(t)} y1={yFor(0)} x2={xFor(t)} y2={yFor(1)}
                      class="calibration-grid"
                    />
                    <line
                      x1={xFor(0)} y1={yFor(t)} x2={xFor(1)} y2={yFor(t)}
                      class="calibration-grid"
                    />
                    <text x={xFor(t)} y={yFor(0) + 14} class="calibration-tick" text-anchor="middle">
                      {pct(t)}
                    </text>
                    <text x={xFor(0) - 6} y={yFor(t) + 3} class="calibration-tick" text-anchor="end">
                      {pct(t)}
                    </text>
                  </>
                )}
              </For>

              {/* Perfect-calibration diagonal */}
              <line
                x1={xFor(0)} y1={yFor(0)} x2={xFor(1)} y2={yFor(1)}
                class="calibration-diagonal"
              />

              {/* Axis titles */}
              <text x={PAD_LEFT + PLOT_W / 2} y={SIZE - 4} class="calibration-axis-title" text-anchor="middle">
                stated belief
              </text>
              <text
                x={10} y={PAD_TOP + PLOT_H / 2}
                class="calibration-axis-title" text-anchor="middle"
                transform={`rotate(-90 10 ${PAD_TOP + PLOT_H / 2})`}
              >
                happened
              </text>

              {/* Curve through non-empty buckets */}
              <Show when={points().length > 1}>
                <path d={linePath()} class="calibration-line" />
              </Show>
              <For each={points()}>
                {(b) => (
                  <circle
                    cx={xFor(b.mean_belief)}
                    cy={yFor(b.observed)}
                    r="5"
                    class="calibration-dot"
                  >
                    <title>
                      {`Stated ~${pct(b.mean_belief)} · happened ${pct(b.observed)} · ${b.n} ${b.n === 1 ? 'market' : 'markets'}`}
                    </title>
                  </circle>
                )}
              </For>
            </svg>
            <div class="calibration-stats">
              <div class="calibration-stat">
                <span class="calibration-stat-value">{data().brier.toFixed(3)}</span>
                <span class="calibration-stat-label">Brier score (0 = perfect)</span>
              </div>
              <div class="calibration-stat">
                <span class="calibration-stat-value">{data().n}</span>
                <span class="calibration-stat-label">resolved predictions</span>
              </div>
              <p class="calibration-note">
                Dots on the dashed line = your stated probabilities match reality.
              </p>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
