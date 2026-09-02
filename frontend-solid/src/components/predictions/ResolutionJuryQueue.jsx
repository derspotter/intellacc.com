import { For, Show, createResource, createSignal } from 'solid-js';
import { api } from '../../services/api';
import { isAdmin } from '../../services/auth';

// Jury-duty surface on the predictions page: open resolution proposals the
// current user was drawn for, plus (for admins) escalated proposals awaiting
// a ruling. Voting itself happens here; details live on the market page.
export default function ResolutionJuryQueue() {
  const [busy, setBusy] = createSignal(null);
  const [error, setError] = createSignal('');

  const [duties, { refetch: refetchDuties }] = createResource(async () => {
    try {
      const rows = await api.resolutionProposals.juryQueue();
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  });

  const [escalations, { refetch: refetchEscalations }] = createResource(async () => {
    if (!isAdmin()) return [];
    try {
      const rows = await api.resolutionProposals.escalations();
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  });

  const act = async (key, fn) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await Promise.all([refetchDuties(), refetchEscalations()]);
    } catch (e) {
      setError(e?.message || 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  const vote = (proposalId, voteValue) =>
    act(`${proposalId}:${voteValue}`, () => api.resolutionProposals.vote(proposalId, { vote: voteValue }));

  const rule = (proposalId, outcome) =>
    act(`${proposalId}:rule:${outcome}`, () => api.resolutionProposals.adminRule(proposalId, { outcome }));

  const outcomeLabel = (row) =>
    row.proposed_outcome ? row.proposed_outcome.toUpperCase() : `outcome #${row.proposed_outcome_id}`;

  return (
    <Show when={(duties() || []).length > 0 || (escalations() || []).length > 0}>
      <section class="market-question-card resolution-jury">
        <h3 class="market-question-section-title">Resolution jury duty</h3>
        <Show when={error()}>
          <div class="error">{error()}</div>
        </Show>

        <Show when={(duties() || []).length > 0}>
          <ul class="resolution-jury-list">
            <For each={duties()}>
              {(row) => (
                <li class="resolution-jury-row">
                  <div>
                    <a href={`#predictions/${row.event_id}`}>{row.event_title}</a>
                    <span class="resolution-jury-meta">
                      {` — proposed ${outcomeLabel(row)} by ${row.proposer_username} · `}
                      <a href={row.source_url} target="_blank" rel="noopener noreferrer">source</a>
                    </span>
                  </div>
                  <div class="resolution-jury-actions">
                    <button
                      type="button"
                      class="button"
                      disabled={busy() !== null}
                      onClick={() => vote(row.id, 'confirm')}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      class="button button-secondary"
                      disabled={busy() !== null}
                      onClick={() => vote(row.id, 'reject')}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={isAdmin() && (escalations() || []).length > 0}>
          <h3 class="market-question-section-title">Escalated resolutions (admin)</h3>
          <ul class="resolution-jury-list">
            <For each={escalations()}>
              {(row) => (
                <li class="resolution-jury-row">
                  <div>
                    <a href={`#predictions/${row.event_id}`}>{row.event_title}</a>
                    <span class="resolution-jury-meta">
                      {` — ${row.escalation_reason}; proposed ${outcomeLabel(row)} by ${row.proposer_username} · `}
                      <a href={row.source_url} target="_blank" rel="noopener noreferrer">source</a>
                    </span>
                  </div>
                  <div class="resolution-jury-actions">
                    <button
                      type="button"
                      class="button"
                      disabled={busy() !== null}
                      onClick={() => rule(row.id, 'yes')}
                    >
                      Rule YES
                    </button>
                    <button
                      type="button"
                      class="button button-secondary"
                      disabled={busy() !== null}
                      onClick={() => rule(row.id, 'no')}
                    >
                      Rule NO
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
