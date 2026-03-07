import van from 'vanjs-core';
import Card from '../common/Card.js';
import Button from '../common/Button.js';
import api from '../../services/api.js';

const { div, h3, p, span, small, label, select, option, ul, li, code, strong } = van.tags;

const formatInteger = (value) => Number(value || 0).toLocaleString();

const formatCost = (value) => {
  const numeric = Number(value || 0);
  if (numeric === 0) return '0';
  if (numeric < 0.001) return numeric.toFixed(8);
  if (numeric < 0.01) return numeric.toFixed(6);
  return numeric.toFixed(4);
};

const formatPercent = (part, total) => {
  const denominator = Number(total || 0);
  if (!denominator) return '0%';
  return `${Math.round((Number(part || 0) / denominator) * 100)}%`;
};

const formatDateTime = (value) => {
  if (!value) return 'Unknown';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return 'Unknown';
  }
};

export default function PostMatchUsageDashboard() {
  const loading = van.state(false);
  const error = van.state('');
  const days = van.state('7');
  const summary = van.state(null);

  const loadSummary = async () => {
    if (loading.val) return;
    loading.val = true;
    error.val = '';

    try {
      summary.val = await api.postMatchUsage.getSummary({
        days: Number(days.val || 7),
        limit: 10
      });
    } catch (err) {
      console.error('[PostMatchUsageDashboard] Failed to load summary:', err);
      error.val = err.message || 'Failed to load matcher spend summary';
    } finally {
      loading.val = false;
    }
  };

  if (summary.val === null && !loading.val) {
    loadSummary();
  }

  return Card({
    className: 'post-match-usage-card',
    title: 'Post Matcher Usage',
    children: [
      p('Tracks OpenRouter token usage, billed cost, provider failures, and the most expensive posts for the matcher pipeline.'),
      div({ class: 'post-match-usage-toolbar' }, [
        label({ class: 'post-match-usage-filter' }, [
          span('Window'),
          select({
            value: days,
            onchange: (event) => {
              days.val = event.target.value;
              loadSummary();
            }
          }, [
            option({ value: '1' }, '1 day'),
            option({ value: '7' }, '7 days'),
            option({ value: '30' }, '30 days'),
            option({ value: '90' }, '90 days')
          ])
        ]),
        Button({
          onclick: loadSummary,
          className: 'button-secondary',
          disabled: () => loading.val,
          children: () => loading.val ? 'Refreshing...' : 'Refresh'
        })
      ]),
      () => error.val ? div({ class: 'error' }, error.val) : null,
      () => {
        const data = summary.val;
        if (!data) {
          return p('Loading matcher usage...');
        }

        const totals = data.totals || {};
        return div({ class: 'post-match-usage-content' }, [
          div({ class: 'post-match-usage-metrics' }, [
            div({ class: 'post-match-usage-metric' }, [
              small('Cost'),
              strong(formatCost(totals.cost_credits))
            ]),
            div({ class: 'post-match-usage-metric' }, [
              small('Calls'),
              strong(formatInteger(totals.api_call_count))
            ]),
            div({ class: 'post-match-usage-metric' }, [
              small('Success'),
              strong(`${formatInteger(totals.api_success_count)} (${formatPercent(totals.api_success_count, totals.api_call_count)})`)
            ]),
            div({ class: 'post-match-usage-metric' }, [
              small('Tokens'),
              strong(formatInteger(totals.total_tokens))
            ])
          ]),

          div({ class: 'post-match-usage-grid' }, [
            div({ class: 'post-match-usage-panel' }, [
              h3('By Stage'),
              ul({ class: 'post-match-usage-list' },
                (data.by_stage || []).map((item) =>
                  li([
                    strong(`${item.stage} / ${item.operation}`),
                    span(`Cost ${formatCost(item.cost_credits)} | Calls ${formatInteger(item.api_call_count)} | Tokens ${formatInteger(item.total_tokens)}`)
                  ])
                )
              )
            ]),
            div({ class: 'post-match-usage-panel' }, [
              h3('Top Models'),
              ul({ class: 'post-match-usage-list' },
                (data.by_model || []).map((item) =>
                  li([
                    strong(item.model || 'unknown'),
                    span(`Cost ${formatCost(item.cost_credits)} | Calls ${formatInteger(item.api_call_count)} | Success ${formatPercent(item.api_success_count, item.api_call_count)}`)
                  ])
                )
              )
            ])
          ]),

          div({ class: 'post-match-usage-panel' }, [
            h3('Top Posts'),
            ul({ class: 'post-match-usage-list' },
              (data.top_posts || []).map((item) =>
                li([
                  strong(`#${item.post_id} by ${item.username}`),
                  span(item.preview || ''),
                  span(`Cost ${formatCost(item.cost_credits)} | Calls ${formatInteger(item.api_call_count)} | Last ${formatDateTime(item.last_call_at)}`)
                ])
              )
            )
          ]),

          div({ class: 'post-match-usage-panel' }, [
            h3('Recent Failures'),
            (data.recent_failures || []).length > 0
              ? ul({ class: 'post-match-usage-list' },
                  data.recent_failures.map((item) =>
                    li([
                      strong(`#${item.post_id} ${item.stage}`),
                      span(`${item.model || 'unknown'} at ${formatDateTime(item.created_at)}`),
                      code(item.error_message || 'Unknown error')
                    ])
                  )
                )
              : p('No recent failures in this window.')
          ])
        ]);
      }
    ]
  });
}
