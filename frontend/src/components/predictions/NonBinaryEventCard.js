import van from 'vanjs-core';
import Button from '../common/Button.js';
import { getUserId, tokenState } from '../../services/auth.js';

const { div, h3, p, span, input, form, button, small } = van.tags;

const formatDate = (dateString) => new Date(dateString).toLocaleDateString('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

const formatPercentage = (value) => `${((Number(value) || 0) * 100).toFixed(1)}%`;
const formatRP = (value) => `${(Number(value) || 0).toFixed(2)} RP`;

const formatBucket = (outcome) => {
  const lower = outcome.lower_bound;
  const upper = outcome.upper_bound;
  if (lower == null && upper == null) return outcome.label || outcome.outcome_key;
  if (lower == null) return `< ${upper}`;
  if (upper == null) return `>= ${lower}`;
  return `${lower} to ${upper}`;
};

export default function NonBinaryEventCard({ event, onStakeUpdate, hideTitle = false }) {
  const market = van.state(null);
  const position = van.state([]);
  const loading = van.state(true);
  const loadingPosition = van.state(false);
  const error = van.state(null);
  const selectedOutcomeId = van.state(null);
  const stakeAmount = van.state('');
  const submitting = van.state(false);

  const loadMarket = async () => {
    try {
      loading.val = true;
      const response = await fetch(`/api/events/${event.id}/market`);
      if (!response.ok) {
        throw new Error(`Failed to load market (${response.status})`);
      }
      const payload = await response.json();
      market.val = payload;
      if (Array.isArray(payload.outcomes) && payload.outcomes.length > 0) {
        selectedOutcomeId.val = payload.outcomes[0].outcome_id;
      }
    } catch (err) {
      error.val = err.message;
    } finally {
      loading.val = false;
    }
  };

  const loadPosition = async () => {
    const userId = getUserId();
    const token = localStorage.getItem('token');
    if (!userId || !token) {
      position.val = [];
      return;
    }
    try {
      loadingPosition.val = true;
      const response = await fetch(`/api/events/${event.id}/shares?user_id=${userId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        position.val = [];
        return;
      }
      const payload = await response.json();
      position.val = Array.isArray(payload.outcome_shares) ? payload.outcome_shares : [];
    } catch {
      position.val = [];
    } finally {
      loadingPosition.val = false;
    }
  };

  const submitStake = async (e) => {
    e.preventDefault();
    if (submitting.val) return;
    if (!selectedOutcomeId.val) {
      error.val = 'Select an outcome first';
      return;
    }
    const stake = Number(stakeAmount.val);
    if (!Number.isFinite(stake) || stake <= 0) {
      error.val = 'Enter a valid stake amount';
      return;
    }

    try {
      submitting.val = true;
      error.val = null;
      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('You must be logged in to trade');
      }

      const response = await fetch(`/api/events/${event.id}/update-outcome`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          user_id: getUserId(),
          outcome_id: selectedOutcomeId.val,
          stake
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || payload.error || 'Failed to place stake');
      }
      market.val = {
        ...(market.val || {}),
        ...payload,
        outcomes: payload.outcomes || market.val?.outcomes || []
      };
      stakeAmount.val = '';
      await loadPosition();
      onStakeUpdate?.(payload);
    } catch (err) {
      error.val = err.message;
    } finally {
      submitting.val = false;
    }
  };

  // Initial load and reload on auth changes.
  loadMarket();
  van.derive(() => {
    tokenState.val;
    loadPosition();
  });

  return () => div({ class: 'event-card' }, [
    hideTitle ? null : div({ class: 'event-header' }, [
      h3({ class: 'event-title' }, event.title),
      div({ class: 'event-meta' }, [
        span({ class: 'event-category' }, event.category || 'General'),
        span({ class: 'event-closing' }, ['📅 Closes: ', formatDate(event.closing_date)])
      ])
    ]),
    () => loading.val
      ? div({ class: 'market-stakes-loading' }, [p('Loading market data...')])
      : null,
    () => (!loading.val && error.val) ? div({ class: 'error-message' }, error.val) : null,
    () => {
      if (loading.val || !market.val) return null;
      const outcomes = Array.isArray(market.val.outcomes) ? market.val.outcomes : [];
      if (outcomes.length < 2) {
        return div({ class: 'no-market-data' }, [
          p('No outcomes configured yet for this market.'),
          small('Admin can configure outcomes via /api/events/:id/outcomes.')
        ]);
      }

      return div({ class: 'betting-interface' }, [
        div({ class: 'market-state' }, [
          div({ class: 'market-stats' }, [
            div({ class: 'stat' }, [
              span({ class: 'stat-label' }, 'Market Type:'),
              span({ class: 'stat-value' }, market.val.market_type || event.event_type || 'multiple_choice')
            ]),
            div({ class: 'stat' }, [
              span({ class: 'stat-label' }, 'Total RP Staked:'),
              span({ class: 'stat-value' }, formatRP(market.val.cumulative_stake || 0))
            ])
          ])
        ]),
        div({ class: 'form-field' }, [
          span({ class: 'stat-label' }, 'Select Outcome:'),
          div({ class: 'direction-buttons', style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;' },
            outcomes.map((outcome) => button({
              type: 'button',
              class: `direction-btn ${selectedOutcomeId.val === outcome.outcome_id ? 'active' : ''}`,
              onclick: () => {
                selectedOutcomeId.val = outcome.outcome_id;
              }
            }, `${formatBucket(outcome)} (${formatPercentage(outcome.prob)})`))
          )
        ]),
        () => localStorage.getItem('token')
          ? form({ class: 'betting-form', onsubmit: submitStake }, [
              div({ class: 'form-row horizontal-row' }, [
                div({ class: 'form-field' }, [
                  span('Stake Amount (RP):'),
                  input({
                    type: 'number',
                    step: '0.01',
                    min: '0.01',
                    value: () => stakeAmount.val,
                    class: 'stake-input',
                    oninput: (e) => { stakeAmount.val = e.target.value; }
                  })
                ])
              ]),
              Button({
                type: 'submit',
                className: 'primary',
                disabled: () => submitting.val || !stakeAmount.val || !selectedOutcomeId.val,
                children: () => submitting.val ? 'Placing Stake...' : 'Place Stake'
              })
            ])
          : div({ class: 'login-prompt' }, [
              p('Log in to place stakes and participate in markets'),
              Button({
                onclick: () => { window.location.hash = 'login'; },
                children: 'Log In'
              })
            ]),
        div({ class: 'user-position', style: () => (position.val.length ? 'display:block;' : 'display:none;') }, [
          span({ class: 'stat-label' }, loadingPosition.val ? 'Loading position...' : 'Your Outcome Shares:'),
          ...position.val.map((row) => div({ class: 'stat' }, [
            span({ class: 'stat-label' }, row.label || row.outcome_key),
            span({ class: 'stat-value' }, `${(Number(row.shares) || 0).toFixed(4)} shares`)
          ]))
        ])
      ]);
    }
  ]);
}
