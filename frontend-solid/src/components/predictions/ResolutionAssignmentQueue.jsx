import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../../services/api';

export default function ResolutionAssignmentQueue() {
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(null);
  const [assignments, { refetch }] = createResource(async () => {
    try {
      const rows = await api.resolutionProposals.assignmentQueue();
      setError('');
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      setError(e?.message || 'Could not load resolution assignments.');
      return [];
    }
  });
  const [config] = createResource(() => api.resolutionProposals.getConfig().catch(() => null));

  onMount(() => {
    const refresh = () => { void refetch(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('resolution-proposal-created', refresh);
    onCleanup(() => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('resolution-proposal-created', refresh);
    });
  });

  const decline = async (id) => {
    setBusy(id);
    setError('');
    try {
      await api.resolutionProposals.declineAssignment(id);
      await refetch();
    } catch (e) {
      setError(e?.message || 'Could not decline this assignment.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Show when={error() || assignments()?.length}>
      <section class="market-question-card resolution-jury" aria-label="Your resolution assignments">
        <h3 class="market-question-section-title">Markets assigned to you</h3>
        <Show when={error()}>
          <p class="error" role="alert">{error()}</p>
          <button type="button" class="button button-secondary" onClick={() => refetch()}>Retry</button>
        </Show>
        <Show when={assignments()?.length}>
          <p>
            You were randomly selected to review these closed markets. Check the outcome and
            propose a resolution with a source. A separate jury will review your proposal.
            Assignment is free, and you can decline.
            <Show when={config()}>
              {` Submitting a proposal stakes ${config().proposerStakeRp} RP, returned with a ${config().proposerRewardRp} RP reward if confirmed and forfeited if overturned.`}
            </Show>
          </p>
          <ul class="resolution-jury-list">
            <For each={assignments()}>
              {(row) => (
                <li class="resolution-jury-row">
                  <div>
                    <a href={`#predictions/${row.event_id}`}>{row.event_title}</a>
                    <span class="resolution-jury-meta">
                      {' · Due '}
                      <time dateTime={row.expires_at}>{new Date(row.expires_at).toLocaleString()}</time>
                    </span>
                  </div>
                  <div class="resolution-jury-actions">
                    <a class="button" href={`#predictions/${row.event_id}`}>Review market</a>
                    <button type="button" class="button button-secondary" disabled={busy() !== null}
                      onClick={() => decline(row.id)}>
                      {busy() === row.id ? 'Declining…' : 'Decline'}
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  );
}
