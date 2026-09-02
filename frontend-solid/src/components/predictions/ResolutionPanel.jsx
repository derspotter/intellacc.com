import { Show, createResource, createSignal } from 'solid-js';
import { api } from '../../services/api';
import { isAuthenticated } from '../../services/auth';

// Community resolution panel for a past-close, unresolved market:
// - no proposal yet -> propose form (outcome + source URL, staked)
// - voting -> status + confirm/reject buttons for drawn jurors
// - challenge_window -> pending outcome + challenge button
// - escalated -> awaiting admin note
const formatDeadline = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function ResolutionPanel(props) {
  const eventId = () => props.event?.id;

  const [refreshKey, setRefreshKey] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [outcome, setOutcome] = createSignal(null); // 'yes' | 'no'
  const [sourceUrl, setSourceUrl] = createSignal('');

  const [config] = createResource(() => api.resolutionProposals.getConfig().catch(() => null));

  const [proposal, { refetch: refetchProposal }] = createResource(
    () => [eventId(), refreshKey()],
    async ([id]) => {
      if (!id) return null;
      try {
        const res = await api.resolutionProposals.getForEvent(id);
        return res?.proposal || null;
      } catch {
        return null;
      }
    }
  );

  const [juryProposalIds, { refetch: refetchJury }] = createResource(
    () => refreshKey(),
    async () => {
      try {
        const rows = await api.resolutionProposals.juryQueue();
        return new Set((Array.isArray(rows) ? rows : []).map((row) => row.id));
      } catch {
        return new Set();
      }
    }
  );

  const refresh = () => {
    setRefreshKey((k) => k + 1);
    void refetchProposal();
    void refetchJury();
  };

  const activeProposal = () => {
    const p = proposal();
    return p && ['voting', 'challenge_window', 'escalated'].includes(p.status) ? p : null;
  };

  const canPropose = () =>
    isAuthenticated() &&
    !activeProposal() &&
    props.event &&
    !props.event.outcome &&
    new Date(props.event.closing_date) <= new Date() &&
    props.event.event_type !== 'numeric';

  const isJuror = () => {
    const p = activeProposal();
    return p && p.status === 'voting' && juryProposalIds()?.has(p.id);
  };

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e?.message || 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const submitProposal = () =>
    run(() => api.resolutionProposals.create(eventId(), {
      outcome: outcome(),
      source_url: sourceUrl().trim()
    }));

  const submitVote = (vote) =>
    run(() => api.resolutionProposals.vote(activeProposal().id, { vote }));

  const submitChallenge = () =>
    run(() => api.resolutionProposals.challenge(activeProposal().id));

  const outcomeLabel = (p) =>
    p.proposed_outcome ? p.proposed_outcome.toUpperCase() : `outcome #${p.proposed_outcome_id}`;

  return (
    <Show when={props.event && !props.event.outcome && new Date(props.event.closing_date) <= new Date()}>
      <div class="market-detail-resolution">
        <h3>Resolution</h3>

        <Show when={error()}>
          <p class="form-error" role="alert">{error()}</p>
        </Show>

        <Show when={canPropose()}>
          <p class="resolution-hint">
            This market has closed. Propose how it resolved — with a source.
            <Show when={config()}>
              {` Stake: ${config().proposerStakeRp} RP (returned + ${config().proposerRewardRp} RP reward if confirmed, forfeited if overturned).`}
            </Show>
          </p>
          <div class="resolution-propose-form">
            <div class="resolution-outcome-buttons" role="group" aria-label="Proposed outcome">
              <button
                type="button"
                classList={{ 'btn-toggle': true, active: outcome() === 'yes' }}
                onClick={() => setOutcome('yes')}
              >
                YES
              </button>
              <button
                type="button"
                classList={{ 'btn-toggle': true, active: outcome() === 'no' }}
                onClick={() => setOutcome('no')}
              >
                NO
              </button>
            </div>
            <input
              type="url"
              placeholder="Source URL backing this resolution"
              value={sourceUrl()}
              onInput={(e) => setSourceUrl(e.currentTarget.value)}
              data-testid="resolution-source-url"
            />
            <button
              type="button"
              class="btn-primary"
              disabled={busy() || !outcome() || !sourceUrl().trim()}
              onClick={submitProposal}
              data-testid="resolution-propose-submit"
            >
              {busy() ? 'Submitting…' : 'Propose resolution'}
            </button>
          </div>
        </Show>

        <Show when={activeProposal()}>
          <div class="resolution-status">
            <p>
              {`Proposed: ${outcomeLabel(activeProposal())} — `}
              <a href={activeProposal().source_url} target="_blank" rel="noopener noreferrer">source</a>
            </p>

            <Show when={activeProposal().status === 'voting'}>
              <p class="resolution-hint">
                {`Jury voting: ${activeProposal().confirms} confirm / ${activeProposal().rejects} reject · until ${formatDeadline(activeProposal().voting_deadline_at)}`}
              </p>
              <Show when={isJuror()}>
                <p class="resolution-hint">
                  {`You are on this jury. Voting stakes ${config()?.voterStakeRp ?? ''} RP; the winning side receives ${config()?.voterPayoutRp ?? ''} RP.`}
                </p>
                <div class="resolution-outcome-buttons" role="group" aria-label="Jury vote">
                  <button type="button" class="btn-primary" disabled={busy()} onClick={() => submitVote('confirm')} data-testid="resolution-vote-confirm">
                    Confirm
                  </button>
                  <button type="button" class="btn-secondary" disabled={busy()} onClick={() => submitVote('reject')} data-testid="resolution-vote-reject">
                    Reject
                  </button>
                </div>
              </Show>
            </Show>

            <Show when={activeProposal().status === 'challenge_window'}>
              <p class="resolution-hint">
                {`Confirmed by the jury — settles as ${outcomeLabel(activeProposal())} after ${formatDeadline(activeProposal().challenge_ends_at)} unless challenged.`}
              </p>
              <button type="button" class="btn-secondary" disabled={busy()} onClick={submitChallenge} data-testid="resolution-challenge">
                Challenge this resolution
              </button>
            </Show>

            <Show when={activeProposal().status === 'escalated'}>
              <p class="resolution-hint">Escalated — awaiting an admin ruling.</p>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}
