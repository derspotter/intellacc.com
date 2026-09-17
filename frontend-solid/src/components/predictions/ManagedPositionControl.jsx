import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { api } from '../../services/api';
import './managedPosition.css';

const fractionLabel = (fraction) => ({ 0.25: '¼', 0.5: '½', 1: 'full' }[fraction] || '');

export default function ManagedPositionControl(props) {
  const [policy, setPolicy] = createSignal(null);
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [pendingEnabled, setPendingEnabled] = createSignal(null);
  const [error, setError] = createSignal('');
  let generation = 0;
  let readVersion = 0;

  const enabled = () => policy()?.enabled === true;
  const dirty = () => enabled() && (
    props.belief !== policy()?.belief_prob || props.fraction !== policy()?.kelly_fraction
  );
  const valid = () => Number.isFinite(props.belief) && props.belief > 0 && props.belief < 1
    && [0.25, 0.5, 1].includes(props.fraction);

  createEffect(() => props.onState?.({ enabled: enabled(), loading: loading() || saving() }));

  createEffect(on(() => props.eventId, (eventId) => {
    const current = ++generation;
    setPolicy(null);
    setLoading(true);
    setSaving(false);
    setPendingEnabled(null);
    setError('');
    let reading = false;
    const refresh = async (initial = false) => {
      if (reading || saving()) return;
      reading = true;
      const version = ++readVersion;
      try {
        const data = await api.events.getManagedPosition(eventId);
        if (current !== generation || version !== readVersion) return;
        const previousTrade = policy()?.last_rebalanced_at;
        setPolicy(data);
        setError('');
        if (initial && data.belief_prob != null) props.onRestore?.(data);
        if (!initial && data.last_rebalanced_at && data.last_rebalanced_at !== previousTrade) {
          window.dispatchEvent(new CustomEvent('rp-balance-refresh'));
          props.onTrade?.();
        }
      } catch (err) {
        if (current === generation && version === readVersion) {
          setError(err?.message || 'Could not load position management.');
        }
      } finally {
        reading = false;
        if (current === generation && version === readVersion) setLoading(false);
      }
    };
    void refresh(true);
    // This only refreshes the display. Trading is scheduled on the server.
    const timer = setInterval(() => void refresh(), 60000);
    onCleanup(() => { clearInterval(timer); generation++; });
  }));

  const save = async (enable) => {
    if (saving() || (enable && !valid())) return;
    const current = generation;
    ++readVersion; // A pending GET must not overwrite a successful save.
    setSaving(true);
    setPendingEnabled(enable);
    setError('');
    try {
      const data = await api.events.setManagedPosition(props.eventId, enable ? {
        enabled: true, belief_prob: props.belief, kelly_fraction: props.fraction
      } : { enabled: false });
      if (current !== generation) return;
      setPolicy(data);
      setLoading(false);
      if (enable) props.onRestore?.(data);
    } catch (err) {
      if (current === generation) setError(err?.message || 'Could not save position management.');
    } finally {
      if (current === generation) {
        setSaving(false);
        setPendingEnabled(null);
      }
    }
  };

  return (
    <div class="managed-position" data-testid="managed-position-control">
      <label class="managed-position-toggle">
        <input
          type="checkbox"
          checked={pendingEnabled() ?? enabled()}
          disabled={loading() || saving() || (!enabled() && (props.closed || !valid() || !policy()))}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            void save(next);
          }}
        />
        Automatically manage
      </label>
      <p class="managed-position-help">
        Adjusts {policy()?.check_interval_seconds && policy().check_interval_seconds !== 86400
          ? `every ${policy().check_interval_seconds / 3600} hours` : 'once a day'} using your
        saved probability, Kelly choice, and available RP—even when you are away.
        It can buy or sell YES or NO and commit more RP as prices change.
        Saved changes apply at the next scheduled check. Pausing keeps your shares.
      </p>
      <Show when={enabled()}>
        <p aria-live="polite">
          Managing at {(policy().belief_prob * 100).toFixed(1)}% · {fractionLabel(policy().kelly_fraction)} Kelly.
          {' '}Pause to trade manually.
        </p>
        <Show when={dirty()}>
          <button type="button" class="button managed-position-save" disabled={saving() || !valid() || props.closed}
            onClick={() => void save(true)}>
            {saving() ? 'Saving…' : 'Save management settings'}
          </button>
          <p class="managed-position-help">Your changes apply after you save.</p>
        </Show>
      </Show>
      <Show when={policy()?.last_trade_summary}>
        <p class="managed-position-help">Last adjustment: {policy().last_trade_summary}</p>
      </Show>
      <Show when={enabled() && policy()?.next_check_at}>
        <p class="managed-position-help">Next check: {new Date(policy().next_check_at).toLocaleString()}</p>
      </Show>
      <Show when={policy()?.last_error}>
        <p role="status">{policy().last_error}</p>
      </Show>
      <Show when={loading()}><p class="managed-position-help">Loading management settings…</p></Show>
      <Show when={saving()}><p role="status">Saving management settings…</p></Show>
      <Show when={error()}><p role="alert">{error()}</p></Show>
    </div>
  );
}
