import van from 'vanjs-core';
import Card from '../common/Card.js';
import Button from '../common/Button.js';
import api from '../../services/api.js';
import { isAdminState, isLoggedInState } from '../../services/auth.js';

const {
  div,
  h2,
  h3,
  p,
  form,
  label,
  input,
  textarea,
  select,
  option,
  ul,
  li,
  span,
  strong,
  small,
  button
} = van.tags;

const toLocalDateTimeValue = (date) => {
  const now = date || new Date();
  const tzOffset = now.getTimezoneOffset() * 60000;
  const local = new Date(now.getTime() - tzOffset);
  return local.toISOString().slice(0, 16);
};

const formatDateTime = (value) => {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return 'Unknown';
  }
};

export default function MarketQuestionHub() {
  const activeTab = van.state('create');
  const config = van.state(null);
  const error = van.state('');
  const success = van.state('');
  const configLoading = van.state(false);

  const title = van.state('');
  const details = van.state('');
  const category = van.state('');
  const closingDate = van.state(toLocalDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1000)));
  const creating = van.state(false);

  const statusFilter = van.state('all');
  const mineOnly = van.state(true);
  const listLoading = van.state(false);
  const listLoaded = van.state(false);
  const submissions = van.state([]);

  const queueLoading = van.state(false);
  const queueLoaded = van.state(false);
  const reviewQueue = van.state([]);
  const reviewSubmitting = van.state(null);
  const reviewNotes = new Map();

  const isReviewerBusy = (id) => reviewSubmitting.val === id;

  const getReviewNoteState = (id) => {
    const key = String(id);
    if (!reviewNotes.has(key)) {
      reviewNotes.set(key, van.state(''));
    }
    return reviewNotes.get(key);
  };

  const clearMessages = () => {
    error.val = '';
    success.val = '';
  };

  const loadConfig = async () => {
    if (configLoading.val) return;
    configLoading.val = true;

    try {
      const response = await api.marketQuestions.getConfig();
      config.val = response;
    } catch (err) {
      console.error('[MarketQuestionHub] Failed to load config:', err);
      config.val = {
        requiredValidators: 5,
        requiredApprovals: 4,
        baseCreatorBondRp: 10,
        creatorBondStepRp: 5,
        validatorStakeRp: 2
      };
    } finally {
      configLoading.val = false;
    }
  };

  const loadSubmissions = async () => {
    if (listLoading.val) return;
    listLoading.val = true;
    clearMessages();

    try {
      const status = statusFilter.val === 'all' ? null : statusFilter.val;
      const payload = {};
      if (status) payload.status = status;
      if (mineOnly.val) payload.mine = true;
      const response = await api.marketQuestions.list(payload);
      submissions.val = response || [];
      listLoaded.val = true;
    } catch (err) {
      console.error('[MarketQuestionHub] Failed to load submissions:', err);
      error.val = err.message || 'Failed to load submissions';
      submissions.val = [];
    } finally {
      listLoading.val = false;
    }
  };

  const loadReviewQueue = async () => {
    if (queueLoading.val) return;
    queueLoading.val = true;
    clearMessages();

    try {
      const response = await api.marketQuestions.getReviewQueue({ limit: 20 });
      reviewQueue.val = response || [];
      queueLoaded.val = true;
    } catch (err) {
      console.error('[MarketQuestionHub] Failed to load review queue:', err);
      error.val = err.message || 'Failed to load review queue';
      reviewQueue.val = [];
    } finally {
      queueLoading.val = false;
    }
  };

  const createSubmission = async (event) => {
    event?.preventDefault?.();
    clearMessages();

    const trimmedTitle = String(title.val || '').trim();
    const trimmedDetails = String(details.val || '').trim();
    const trimmedCategory = String(category.val || '').trim() || null;

    if (!trimmedTitle || !trimmedDetails || !closingDate.val) {
      error.val = 'Title, details, and closing date are required';
      return;
    }

    const parsedDate = new Date(closingDate.val);
    if (Number.isNaN(parsedDate.getTime())) {
      error.val = 'Closing date must be valid';
      return;
    }
    if (parsedDate <= new Date()) {
      error.val = 'Closing date must be in the future';
      return;
    }

    creating.val = true;
    try {
      const payload = {
        title: trimmedTitle,
        details: trimmedDetails,
        category: trimmedCategory,
        closing_date: parsedDate.toISOString()
      };
      const result = await api.marketQuestions.create(payload);
      success.val = `Submitted. Bond withheld: ${result?.creator_bond_rp ?? '10'} RP`;
      title.val = '';
      details.val = '';
      category.val = '';
      closingDate.val = toLocalDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1000));
      mineOnly.val = true;
      activeTab.val = 'mine';
      listLoaded.val = false;
      await loadSubmissions();
    } catch (err) {
      console.error('[MarketQuestionHub] Failed to create submission:', err);
      error.val = err.message || 'Failed to submit question';
    } finally {
      creating.val = false;
    }
  };

  const submitReview = async (submissionId, vote) => {
    if (reviewSubmitting.val) return;
    reviewSubmitting.val = submissionId;
    clearMessages();

    try {
      const noteState = getReviewNoteState(submissionId);
      const response = await api.marketQuestions.submitReview(submissionId, {
        vote,
        note: noteState.val || null
      });

      const message =
        response?.finalized && response.finalized
          ? `Review finalized. Outcome: ${response.approved ? 'approved' : 'rejected'}.`
          : `Review submitted (${response?.submission?.total_reviews || 1}/${response?.submission?.required_validators || '...'}).`;
      success.val = message;
      noteState.val = '';

      queueLoaded.val = false;
      listLoaded.val = false;
      await loadReviewQueue();
      await loadSubmissions();
    } catch (err) {
      console.error('[MarketQuestionHub] Failed to submit review:', err);
      error.val = err.message || 'Failed to submit review';
    } finally {
      reviewSubmitting.val = null;
    }
  };

  const runAutoRewards = async () => {
    clearMessages();
    try {
      const result = await api.marketQuestions.runAutomaticRewards();
      success.val = `Reward sweep complete: ${result.processed || 0} candidates, traction=${result.traction_rewarded || 0}, resolution=${result.resolution_rewarded || 0}.`;
    } catch (err) {
      console.error('[MarketQuestionHub] Auto rewards failed:', err);
      error.val = err.message || 'Failed to run reward sweep';
    }
  };

  // One-time load.
  if (config.val === null && !configLoading.val) {
    loadConfig();
  }

  const renderConfigBanner = () => {
    if (!config.val) return null;

    return div({ class: 'market-question-config' }, [
      span(`Review requires ${config.val.required_validators} validators, `),
      span(`minimum approvals ${config.val.requiredApprovals}, `),
      span(`submission bond: ${config.val.baseCreatorBondRp} + ${config.val.creatorBondStepRp} RP step`)
    ]);
  };

  const renderSubmissionForm = () => {
    const cfg = config.val;
    const createLabel = cfg
      ? `Submit question (${cfg.baseCreatorBondRp} RP base bond)`
      : 'Submit question';

    return Card({ className: 'market-question-card', title: 'Submit a New Question' }, [
      renderConfigBanner(),
      form({ onsubmit: createSubmission, class: 'market-question-form' }, [
        label({ for: 'mq-title' }, 'Title'),
        input({
          id: 'mq-title',
          type: 'text',
          value: () => title.val,
          oninput: (event) => (title.val = event.target.value),
          placeholder: 'Example: Will X happen by date Y?'
        }),

        label({ for: 'mq-details' }, 'Details'),
        textarea({
          id: 'mq-details',
          rows: 5,
          value: () => details.val,
          oninput: (event) => (details.val = event.target.value),
          placeholder: 'Include specific, falsifiable wording and closing criteria.'
        }),

        label({ for: 'mq-category' }, 'Category (optional)'),
        input({
          id: 'mq-category',
          type: 'text',
          value: () => category.val,
          oninput: (event) => (category.val = event.target.value),
          placeholder: 'Politics, Crypto, Sports, etc.'
        }),

        label({ for: 'mq-closing-date' }, 'Closing Date'),
        input({
          id: 'mq-closing-date',
          type: 'datetime-local',
          min: toLocalDateTimeValue(new Date()),
          value: () => closingDate.val,
          oninput: (event) => (closingDate.val = event.target.value)
        }),

        div({ class: 'market-question-form-actions' }, [
          Button({
            type: 'submit',
            className: 'button-primary',
            disabled: () => creating.val,
            children: () => creating.val ? 'Submitting...' : createLabel
          })
        ])
      ])
    ]);
  };

  const renderReviewQueue = () => {
    if (!queueLoaded.val) {
      queueLoaded.val = true;
      loadReviewQueue();
    }

    return Card({ className: 'market-question-card', title: 'Review Queue' }, [
      div({ class: 'market-question-card-subtitle' }, 'Review questions submitted by other users. You stake 2 RP to review each submission.'),
      queueLoading.val
        ? p('Loading queue...')
        : reviewQueue.val.length === 0
          ? p('No pending reviews available right now.')
          : ul({ class: 'market-question-list' },
            reviewQueue.val.map((submission) => {
              const noteState = getReviewNoteState(submission.id);
              const approveBusy = () => isReviewerBusy(submission.id) && reviewSubmitting.val === submission.id;
              return li({ class: 'market-question-item' }, [
                div({ class: 'market-question-item-header' }, [
                  div({ class: 'market-question-title' }, String(submission.title || 'Untitled')),
                  div({ class: 'market-question-meta' }, [
                    span(`Creator: ${submission.creator_username || `User #${submission.creator_user_id}`}`),
                    span(` | Category: ${submission.category || 'General'}`),
                    span(` | Closes: ${formatDateTime(submission.closing_date)}`)
                  ])
                ]),
                p({ class: 'market-question-details' }, String(submission.details || 'No details provided.')),
                div({ class: 'market-question-votes' }, [
                  span(`Current: ${submission.approvals || 0}/${submission.required_approvals} approvals | `),
                  span(`${submission.rejections || 0}/${submission.required_validators - Number(submission.rejections || 0)} rejections`)
                ]),
                div({ class: 'market-question-note' }, [
                  textarea({
                    placeholder: 'Optional note (visible to creator)',
                    rows: 2,
                    value: () => noteState.val,
                    oninput: (event) => (noteState.val = event.target.value)
                  })
                ]),
                div({ class: 'market-question-item-actions' }, [
                  button({
                    class: 'button button-secondary',
                    type: 'button',
                    disabled: approveBusy,
                    onclick: () => submitReview(submission.id, 'approve')
                  }, () => approveBusy() ? 'Submitting...' : 'Approve'),
                  button({
                    class: 'button button-secondary',
                    type: 'button',
                    disabled: approveBusy,
                    onclick: () => submitReview(submission.id, 'reject')
                  }, () => approveBusy() ? 'Submitting...' : 'Reject')
                  ])
              ]);
            })
          )
    ]);
  };

  const renderMySubmissions = () => {
    if (!listLoaded.val) {
      loadSubmissions();
    }

    return Card({ className: 'market-question-card', title: 'My Submissions' }, [
      div({ class: 'market-question-filters' }, [
        label({ for: 'mq-status-filter' }, 'Status: '),
        select({
          id: 'mq-status-filter',
          value: () => statusFilter.val,
          onchange: (event) => {
            statusFilter.val = event.target.value;
            listLoaded.val = false;
            mineOnly.val = true;
            loadSubmissions();
          }
        }, [
          option({ value: 'all' }, 'All'),
          option({ value: 'pending' }, 'Pending'),
          option({ value: 'approved' }, 'Approved'),
          option({ value: 'rejected' }, 'Rejected')
        ]),
        Button({
          className: 'button-secondary',
          onclick: loadSubmissions,
          children: () => listLoading.val ? 'Loading...' : 'Refresh'
        })
      ]),

      listLoading.val
        ? p('Loading submissions...')
        : submissions.val.length === 0
          ? p('No matching submissions found.')
          : ul({ class: 'market-question-list' },
              submissions.val.map((submission) => li({ class: 'market-question-item' }, [
                div({ class: 'market-question-item-header' }, [
                  div({ class: 'market-question-title' }, String(submission.title || 'Untitled')),
                  div({ class: 'market-question-status' }, String(submission.status || 'unknown')),
                ]),
                div({ class: 'market-question-meta' }, [
                  span(`Creator bond: ${Number(submission.creator_bond_rp || 0)} RP`),
                  span(` | Reviews: ${submission.total_reviews || 0}/${submission.required_validators || 5}`),
                  span(` | Approvals: ${submission.approvals || 0}`),
                  span(` | Rejections: ${submission.rejections || 0}`),
                  span(` | Closes: ${formatDateTime(submission.closing_date)}`)
                ]),
                p({ class: 'market-question-details' }, String(submission.details || '')),
                submission.approved_event_id
                  ? div({ class: 'market-question-submission-meta' }, [
                      div({ class: 'market-question-status-note' }, [
                        strong('Linked event: '),
                        small(`#${submission.approved_event_id}`)
                      ])
                    ])
                  : null
              ]))
            )
    ]);
  };

  const renderTab = (id, tabLabel) => {
    const isActive = () => activeTab.val === id;
    return Button({
      className: () => `market-question-tab ${isActive() ? 'is-active' : ''}`,
      onclick: () => {
        activeTab.val = id;
        if (id === 'mine') {
          mineOnly.val = true;
          statusFilter.val = 'all';
          listLoaded.val = false;
          loadSubmissions();
        }
        if (id === 'review') {
          queueLoaded.val = false;
          loadReviewQueue();
        }
      },
      children: tabLabel
    });
  };

  return div({ class: 'market-question-hub' }, [
    h2('Community Market Questions'),
    h3(isAdminState.val ? 'Creator + Validator Flow' : 'Creator + Validator Flow'),

    div({ class: 'market-question-tabs' }, [
      renderTab('create', 'Submit'),
      renderTab('review', 'Review Queue'),
      renderTab('mine', 'My Submissions')
    ]),

    () => configLoading.val ? p('Loading...') : null,

    () => error.val ? div({ class: 'error' }, error.val) : null,
    () => success.val ? div({ class: 'success' }, success.val) : null,

    () => {
      if (activeTab.val === 'create') {
        return renderSubmissionForm();
      }

      if (!isLoggedInState.val) {
        return div({ class: 'market-question-login-hint' }, 'Log in to access this section.');
      }

      if (activeTab.val === 'review') {
        return renderReviewQueue();
      }

      if (activeTab.val === 'mine') {
        return renderMySubmissions();
      }

      return renderSubmissionForm();
    },

    () => isAdminState.val
      ? Card({
        className: 'market-question-admin',
        title: 'Admin Helpers'
      }, [
          p('Automatically process traction + resolution rewards for eligible approved questions.'),
          Button({
            onclick: runAutoRewards,
            className: 'button-secondary',
            children: 'Run reward sweep now'
          })
        ])
      : null
  ]);
}
