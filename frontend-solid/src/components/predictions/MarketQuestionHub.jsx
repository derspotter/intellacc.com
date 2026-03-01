import { createEffect, createSignal, For, Show } from 'solid-js';
import { isAuthenticated, isAdmin } from '../../services/auth';
import {
  createMarketQuestion,
  getMarketQuestionConfig,
  getMarketQuestionReviewQueue,
  listMarketQuestions,
  runMarketQuestionRewards,
  submitMarketQuestionReview
} from '../../services/api';

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

const getValidationError = (title, details, closingDate) => {
  const trimmedTitle = String(title || '').trim();
  const trimmedDetails = String(details || '').trim();
  if (!trimmedTitle || !trimmedDetails || !closingDate) {
    return 'Title, details, and closing date are required';
  }
  const parsedDate = new Date(closingDate);
  if (Number.isNaN(parsedDate.getTime())) {
    return 'Closing date must be valid';
  }
  if (parsedDate <= new Date()) {
    return 'Closing date must be in the future';
  }
  return '';
};

export default function MarketQuestionHub() {
  const [activeTab, setActiveTab] = createSignal('create');
  const [config, setConfig] = createSignal(null);
  const [errors, setErrors] = createSignal('');
  const [success, setSuccess] = createSignal('');
  const [configLoading, setConfigLoading] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [submissions, setSubmissions] = createSignal([]);
  const [listLoading, setListLoading] = createSignal(false);
  const [listLoaded, setListLoaded] = createSignal(false);
  const [reviewQueue, setReviewQueue] = createSignal([]);
  const [queueLoading, setQueueLoading] = createSignal(false);
  const [queueLoaded, setQueueLoaded] = createSignal(false);
  const [reviewSubmitting, setReviewSubmitting] = createSignal(null);
  const [statusFilter, setStatusFilter] = createSignal('all');
  const [mineOnly, setMineOnly] = createSignal(true);
  const [title, setTitle] = createSignal('');
  const [details, setDetails] = createSignal('');
  const [category, setCategory] = createSignal('');
  const [closingDate, setClosingDate] = createSignal(toLocalDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1000)));
  const [reviewNotes, setReviewNotes] = createSignal({});

  const noteFor = (id) => {
    const map = reviewNotes();
    const key = String(id);
    return map[key] || '';
  };

  const setNoteFor = (id, value) => {
    const key = String(id);
    setReviewNotes((current) => ({
      ...current,
      [key]: value
    }));
  };

  const clearMessages = () => {
    setErrors('');
    setSuccess('');
  };

  const loadConfig = async () => {
    if (configLoading()) {
      return;
    }
    setConfigLoading(true);
    try {
      const response = await getMarketQuestionConfig();
      if (!response || typeof response !== 'object') {
        throw new Error('Invalid config response');
      }
      setConfig(response);
    } catch (error) {
      setConfig({
        requiredValidators: 5,
        requiredApprovals: 4,
        baseCreatorBondRp: 10,
        creatorBondStepRp: 5,
        validatorStakeRp: 2
      });
      console.error('[MarketQuestionHub] Failed to load config', error);
    } finally {
      setConfigLoading(false);
    }
  };

  const loadSubmissions = async () => {
    if (listLoading()) {
      return;
    }
    setListLoading(true);
    clearMessages();
    try {
      const response = await listMarketQuestions({
        status: statusFilter() === 'all' ? null : statusFilter(),
        mine: mineOnly(),
        limit: 50,
        offset: 0
      });
    setSubmissions(Array.isArray(response) ? response : response || []);
      setListLoaded(true);
    } catch (error) {
      setErrors(error?.message || 'Failed to load submissions');
      setSubmissions([]);
      setListLoaded(false);
    } finally {
      setListLoading(false);
    }
  };

  const loadReviewQueue = async () => {
    if (queueLoading()) {
      return;
    }
    setQueueLoading(true);
    clearMessages();
    try {
      const response = await getMarketQuestionReviewQueue({ limit: 20 });
      setReviewQueue(Array.isArray(response) ? response : response || []);
      setQueueLoaded(true);
    } catch (error) {
      setErrors(error?.message || 'Failed to load review queue');
      setReviewQueue([]);
      setQueueLoaded(false);
    } finally {
      setQueueLoading(false);
    }
  };

  const createSubmission = async (event) => {
    event?.preventDefault?.();
    clearMessages();

    const validationMessage = getValidationError(title(), details(), closingDate());
    if (validationMessage) {
      setErrors(validationMessage);
      return;
    }

    setCreating(true);
    try {
      const payload = {
        title: String(title()).trim(),
        details: String(details()).trim(),
        category: String(category()).trim() || null,
        closing_date: new Date(closingDate()).toISOString()
      };
      const result = await createMarketQuestion(payload);
      setSuccess(`Submitted. Bond withheld: ${result?.creator_bond_rp ?? '10'} RP`);
      setTitle('');
      setDetails('');
      setCategory('');
      setClosingDate(toLocalDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1000)));
      setMineOnly(true);
      setActiveTab('mine');
      setListLoaded(false);
      await loadSubmissions();
    } catch (error) {
      setErrors(error?.message || 'Failed to submit question');
    } finally {
      setCreating(false);
    }
  };

  const submitReview = async (submissionId, vote) => {
    if (reviewSubmitting()) {
      return;
    }
    setReviewSubmitting(submissionId);
    clearMessages();

    try {
      const note = noteFor(submissionId) || null;
      const response = await submitMarketQuestionReview(submissionId, vote, note);
      setSuccess(
        response?.finalized && response.finalized
          ? `Review finalized. Outcome: ${response?.approved ? 'approved' : 'rejected'}.`
          : `Review submitted (${response?.submission?.total_reviews || 1}/${response?.submission?.required_validators || '...'}).`
      );
      setQueueLoaded(false);
      setListLoaded(false);
      setNoteFor(submissionId, '');
      await loadReviewQueue();
      await loadSubmissions();
    } catch (error) {
      setErrors(error?.message || 'Failed to submit review');
    } finally {
      setReviewSubmitting(null);
    }
  };

  const runAutoRewards = async () => {
    if (!isAdmin()) {
      return;
    }

    try {
      setSuccess('Running reward sweep...');
      const response = await runMarketQuestionRewards();
      setSuccess(
        `Reward sweep complete: ${response?.processed || 0} candidates, ` +
        `traction=${response?.traction_rewarded || 0}, resolution=${response?.resolution_rewarded || 0}.`
      );
    } catch (error) {
      setErrors(error?.message || 'Failed to run reward sweep');
    }
  };

  createEffect(() => {
    if (!config()) {
      loadConfig();
    }
  });

  const configNode = () => {
    const cfg = config();
    if (!cfg) {
      return null;
    }
    const validators = cfg.requiredValidators ?? cfg.required_validators ?? 5;
    const approvals = cfg.requiredApprovals ?? cfg.required_approvals ?? 4;
    const bondBase = cfg.baseCreatorBondRp ?? cfg.base_creator_bond_rp ?? 10;
    const bondStep = cfg.creatorBondStepRp ?? cfg.creator_bond_step_rp ?? 5;

    return (
      <div class="market-question-config">
        <span>Review requires {validators} validators, </span>
        <span>minimum approvals {approvals}, </span>
        <span>submission bond: {bondBase} + {bondStep} RP step</span>
      </div>
    );
  };

  const renderSubmissionForm = () => (
    <section class="market-question-card">
      {configNode()}
      <form class="market-question-form" onSubmit={createSubmission}>
        <label for="mq-title">Title</label>
        <input
          id="mq-title"
          type="text"
          value={title()}
          onInput={(event) => setTitle(event.target.value)}
          placeholder="Example: Will X happen by date Y?"
        />
        <label for="mq-details">Details</label>
        <textarea
          id="mq-details"
          rows={5}
          value={details()}
          onInput={(event) => setDetails(event.target.value)}
          placeholder="Include specific, falsifiable wording and closing criteria."
        />
        <label for="mq-category">Category (optional)</label>
        <input
          id="mq-category"
          type="text"
          value={category()}
          onInput={(event) => setCategory(event.target.value)}
          placeholder="Politics, Crypto, Sports, etc."
        />
        <label for="mq-closing-date">Closing Date</label>
        <input
          id="mq-closing-date"
          type="datetime-local"
          min={toLocalDateTimeValue(new Date())}
          value={closingDate()}
          onInput={(event) => setClosingDate(event.target.value)}
        />
        <div class="market-question-form-actions">
          <button type="submit" class="button button-primary" disabled={creating()}>
            {creating() ? 'Submitting...' : 'Submit question'}
          </button>
        </div>
      </form>
    </section>
  );

  const renderReviewQueue = () => {
    if (!queueLoaded()) {
      loadReviewQueue();
    }

    return (
      <section class="market-question-card">
        <p class="market-question-card-subtitle">Review questions submitted by other users.</p>
        <Show when={queueLoading()}>
          <p>Loading queue…</p>
        </Show>
        <Show when={!queueLoading() && reviewQueue().length === 0}>
          <p>No pending reviews available right now.</p>
        </Show>
        <ul class="market-question-list">
          <For each={reviewQueue()}>
            {(submission) => {
              const busy = () => reviewSubmitting() === submission.id;
              return (
                <li class="market-question-item">
                  <div class="market-question-item-header">
                    <div class="market-question-title">{submission.title || 'Untitled'}</div>
                    <div class="market-question-meta">
                      <span>{`Creator: ${submission.creator_username || `User #${submission.creator_user_id}`}`}</span>
                      <span> | </span>
                      <span>{`Category: ${submission.category || 'General'}`}</span>
                      <span> | </span>
                      <span>{`Closes: ${formatDateTime(submission.closing_date)}`}</span>
                    </div>
                  </div>
                  <p class="market-question-details">{submission.details || 'No details provided.'}</p>
                  <div class="market-question-votes">
                    <span>{`Current: ${submission.approvals || 0}/${submission.required_approvals} approvals | `}</span>
                    <span>{`${submission.rejections || 0}/${submission.required_validators - Number(submission.rejections || 0)} rejections`}</span>
                  </div>
                  <div class="market-question-note">
                    <textarea
                      placeholder="Optional note (visible to creator)"
                      rows={2}
                      value={noteFor(submission.id)}
                      onInput={(event) => setNoteFor(submission.id, event.target.value)}
                    />
                  </div>
                  <div class="market-question-item-actions">
                    <button
                      class="button button-secondary"
                      type="button"
                      disabled={busy()}
                      onClick={() => submitReview(submission.id, 'approve')}
                    >
                      {busy() ? 'Submitting...' : 'Approve'}
                    </button>
                    <button
                      class="button button-secondary"
                      type="button"
                      disabled={busy()}
                      onClick={() => submitReview(submission.id, 'reject')}
                    >
                      {busy() ? 'Submitting…' : 'Reject'}
                    </button>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    );
  };

  const renderMySubmissions = () => {
    if (!listLoaded()) {
      loadSubmissions();
    }

    return (
      <section class="market-question-card">
        <div class="market-question-filters">
          <label for="mq-status-filter">Status:</label>
          <select
            id="mq-status-filter"
            value={statusFilter()}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setMineOnly(true);
              setListLoaded(false);
              loadSubmissions();
            }}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <button
            type="button"
            class="button button-secondary"
            onClick={() => loadSubmissions()}
          >
            {listLoading() ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        <Show when={listLoading()}>
          <p>Loading submissions…</p>
        </Show>
        <Show when={!listLoading() && submissions().length === 0}>
          <p>No matching submissions found.</p>
        </Show>
        <ul class="market-question-list">
          <For each={submissions()}>
            {(submission) => (
              <li class="market-question-item">
                <div class="market-question-item-header">
                  <div class="market-question-title">{submission.title || 'Untitled'}</div>
                  <div class="market-question-status">{submission.status || 'unknown'}</div>
                </div>
                <div class="market-question-meta">
                  <span>{`Creator bond: ${Number(submission.creator_bond_rp || 0)} RP`}</span>
                  <span> | </span>
                  <span>{`Reviews: ${submission.total_reviews || 0}/${submission.required_validators || 5}`}</span>
                  <span> | </span>
                  <span>{`Approvals: ${submission.approvals || 0}`}</span>
                  <span> | </span>
                  <span>{`Rejections: ${submission.rejections || 0}`}</span>
                  <span> | </span>
                  <span>{`Closes: ${formatDateTime(submission.closing_date)}`}</span>
                </div>
                <p class="market-question-details">{submission.details || ''}</p>
                <Show when={submission.approved_event_id}>
                  <div class="market-question-submission-meta">
                    <div class="market-question-status-note">Linked event: #{submission.approved_event_id}</div>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>
    );
  };

  const currentTabContent = () => {
    if (activeTab() === 'create') {
      return renderSubmissionForm();
    }
    if (!isAuthenticated()) {
      return <div class="market-question-login-hint">Log in to access this section.</div>;
    }
    if (activeTab() === 'review') {
      return renderReviewQueue();
    }
    if (activeTab() === 'mine') {
      return renderMySubmissions();
    }
    return renderSubmissionForm();
  };

  const setTab = (next) => {
    if (next === activeTab()) {
      return;
    }
    setActiveTab(next);
    if (next === 'mine') {
      setMineOnly(true);
      setStatusFilter('all');
      setListLoaded(false);
      loadSubmissions();
    }
    if (next === 'review') {
      setQueueLoaded(false);
      loadReviewQueue();
    }
  };

  return (
    <section class="market-question-hub">
      <h2>Community Market Questions</h2>
      <h3>Creator + Validator Flow</h3>

      <div class="market-question-tabs">
        <button
          type="button"
          class={`market-question-tab ${activeTab() === 'create' ? 'is-active' : ''}`}
          onClick={() => setTab('create')}
        >
          Submit
        </button>
        <button
          type="button"
          class={`market-question-tab ${activeTab() === 'review' ? 'is-active' : ''}`}
          onClick={() => setTab('review')}
        >
          Review Queue
        </button>
        <button
          type="button"
          class={`market-question-tab ${activeTab() === 'mine' ? 'is-active' : ''}`}
          onClick={() => setTab('mine')}
        >
          My Submissions
        </button>
      </div>

      <Show when={configLoading()}>Loading…</Show>
      <Show when={errors()}>
        <div class="error">{errors()}</div>
      </Show>
      <Show when={success()}>
        <div class="success">{success()}</div>
      </Show>

      {currentTabContent()}

      <Show when={isAdmin()}>
        <section class="market-question-card">
          <h3>Admin Helpers</h3>
          <p>Automatically process traction + resolution rewards for eligible approved questions.</p>
          <button
            type="button"
            class="button button-secondary"
            onClick={() => runAutoRewards()}
          >
            Run reward sweep now
          </button>
        </section>
      </Show>
    </section>
  );
}
