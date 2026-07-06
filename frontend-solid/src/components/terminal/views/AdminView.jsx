import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import { isAdmin } from '../../../services/auth';
import {
  api,
  getEvents,
  resolveEvent,
  getMarketQuestionReviewQueue,
  submitMarketQuestionReview,
  runMarketQuestionRewards
} from '../../../services/api';

// Parity note: the van skin's "AdminEventManagement" component is misnamed —
// it is actually a *prediction placement* form, not an admin tool. Regular
// prediction placement already lives in the market pane (MarketPanel), so it
// is deliberately NOT reproduced here. This view only covers genuinely
// admin-only actions: creating/resolving events, the market-question review
// queue, and maintenance sweeps.

function Section(props) {
  return (
    <div class="border-b border-bb-border/60">
      <div class="px-3 py-1.5 bg-bb-panel text-bb-accent font-bold uppercase text-xs border-b border-bb-border/40">
        [{props.title}]
      </div>
      <div class="p-3">
        {props.children}
      </div>
    </div>
  );
}

function CreateEventSection(props) {
  const [title, setTitle] = createSignal('');
  const [details, setDetails] = createSignal('');
  const [closing, setClosing] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [success, setSuccess] = createSignal('');
  const [error, setError] = createSignal('');

  const submit = async () => {
    if (!title().trim() || !closing()) {
      setError('TITLE AND CLOSING DATE ARE REQUIRED');
      return;
    }
    setCreating(true);
    setError('');
    setSuccess('');
    try {
      const closing_date = new Date(closing()).toISOString();
      await api.events.create({ title: title().trim(), details: details().trim() || null, closing_date });
      setSuccess('EVENT CREATED');
      setTitle('');
      setDetails('');
      setClosing('');
      props.onCreated?.();
    } catch (e) {
      setError(e?.message || 'FAILED TO CREATE EVENT');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div class="text-xs flex flex-col gap-2 max-w-md">
      <label class="flex flex-col gap-1">
        <span class="text-bb-muted uppercase">Title</span>
        <input
          type="text"
          data-testid="admin-event-title"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-bb-muted uppercase">Details</span>
        <textarea
          rows={3}
          data-testid="admin-event-details"
          value={details()}
          onInput={(e) => setDetails(e.currentTarget.value)}
          class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-bb-muted uppercase">Closing Date</span>
        <input
          type="datetime-local"
          data-testid="admin-event-closing"
          value={closing()}
          onInput={(e) => setClosing(e.currentTarget.value)}
          class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
        />
      </label>
      <div class="flex items-center gap-3 mt-1">
        <button
          type="button"
          data-testid="admin-event-create"
          disabled={creating()}
          onClick={submit}
          class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
        >
          {creating() ? '[CREATING...]' : '[CREATE EVENT]'}
        </button>
        <Show when={success()}>
          <span class="text-market-up">{success()}</span>
        </Show>
        <Show when={error()}>
          <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
        </Show>
      </div>
    </div>
  );
}

function ResolveMarketSection(props) {
  const [allEvents, setAllEvents] = createSignal([]);
  const [loaded, setLoaded] = createSignal(false);
  const [search, setSearch] = createSignal('');
  const [picked, setPicked] = createSignal(null);
  const [outcome, setOutcome] = createSignal(null); // 'yes' | 'no'
  const [submitting, setSubmitting] = createSignal(false);
  const [success, setSuccess] = createSignal('');
  const [error, setError] = createSignal('');

  // getEvents('') returns the full (unpaginated) events list — fetch it once
  // (and again whenever CreateEventSection reports a new event, via
  // props.refreshToken) and filter/search client-side rather than
  // round-tripping per keystroke against a table with thousands of rows.
  createEffect(() => {
    props.refreshToken?.();
    getEvents('')
      .then((list) => setAllEvents(Array.isArray(list) ? list : (Array.isArray(list?.items) ? list.items : [])))
      .catch(() => setAllEvents([]))
      .finally(() => setLoaded(true));
  });

  const matches = createMemo(() => {
    const q = search().trim().toLowerCase();
    if (!q) return [];
    return allEvents()
      .filter((e) => !e.outcome)
      .filter((e) => (e.title || '').toLowerCase().includes(q) || (e.details || '').toLowerCase().includes(q))
      .slice(0, 10);
  });

  const pick = (event) => {
    setPicked(event);
    setOutcome(null);
    setSuccess('');
    setError('');
  };

  const submit = async () => {
    if (!picked() || !outcome()) return;
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      await resolveEvent(picked().id, outcome());
      setSuccess(`RESOLVED AS ${outcome().toUpperCase()}`);
      setAllEvents((prev) => prev.filter((e) => e.id !== picked().id));
      setPicked(null);
      setOutcome(null);
    } catch (e) {
      setError(e?.message || 'FAILED TO RESOLVE EVENT');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="text-xs flex flex-col gap-2 max-w-lg">
      <input
        type="text"
        data-testid="admin-resolve-search"
        placeholder="SEARCH UNRESOLVED EVENTS BY TITLE..."
        value={search()}
        onInput={(e) => setSearch(e.currentTarget.value)}
        class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
      />
      <Show when={!loaded()}>
        <div class="text-bb-muted animate-pulse">LOADING EVENTS...</div>
      </Show>
      <Show when={loaded() && search().trim() && matches().length === 0}>
        <div class="text-bb-muted">NO UNRESOLVED MATCHES</div>
      </Show>
      <div class="flex flex-col border border-bb-border/40 divide-y divide-bb-border/30">
        <For each={matches()}>
          {(event) => (
            <button
              type="button"
              data-testid="admin-resolve-pick"
              onClick={() => pick(event)}
              class={`text-left px-2 py-1 hover:bg-bb-active/10 ${
                picked()?.id === event.id ? 'bg-bb-accent/15 text-bb-accent' : 'text-bb-text'
              }`}
            >
              <div class="font-bold truncate">#{event.id} {event.title}</div>
              <div class="text-bb-muted text-xxs">Closes: {event.closing_date || '--'}</div>
            </button>
          )}
        </For>
      </div>

      <Show when={picked()}>
        <div class="flex items-center gap-3 mt-2 border-t border-bb-border/40 pt-2">
          <span class="text-bb-muted uppercase">Resolve #{picked().id} as:</span>
          <button
            type="button"
            data-testid="admin-resolve-yes"
            onClick={() => setOutcome('yes')}
            class={`px-3 py-1 border uppercase font-bold ${
              outcome() === 'yes' ? 'bg-market-up/20 text-market-up border-market-up' : 'border-bb-border text-bb-muted hover:text-bb-text'
            }`}
          >
            [YES]
          </button>
          <button
            type="button"
            data-testid="admin-resolve-no"
            onClick={() => setOutcome('no')}
            class={`px-3 py-1 border uppercase font-bold ${
              outcome() === 'no' ? 'bg-market-down/20 text-market-down border-market-down' : 'border-bb-border text-bb-muted hover:text-bb-text'
            }`}
          >
            [NO]
          </button>
          <button
            type="button"
            data-testid="admin-resolve-submit"
            disabled={!outcome() || submitting()}
            onClick={submit}
            class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
          >
            {submitting() ? '[RESOLVING...]' : '[RESOLVE]'}
          </button>
        </div>
      </Show>
      <Show when={success()}>
        <span class="text-market-up">{success()}</span>
      </Show>
      <Show when={error()}>
        <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
      </Show>
    </div>
  );
}

function ReviewQueueSection() {
  const [queue, setQueue] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);
  const [busyId, setBusyId] = createSignal(null);
  const [rewardsResult, setRewardsResult] = createSignal(null);
  const [success, setSuccess] = createSignal('');
  const [error, setError] = createSignal('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getMarketQuestionReviewQueue({ limit: 20 });
      setQueue(Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []));
    } catch (e) {
      setError(e?.message || 'FAILED TO LOAD REVIEW QUEUE');
      setQueue([]);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  onMount(load);

  const vote = async (id, decision) => {
    setBusyId(id);
    setError('');
    setSuccess('');
    try {
      await submitMarketQuestionReview(id, decision, null);
      setSuccess(`VOTE SUBMITTED: ${decision.toUpperCase()}`);
      await load();
    } catch (e) {
      setError(e?.message || 'FAILED TO SUBMIT REVIEW');
    } finally {
      setBusyId(null);
    }
  };

  const runRewards = async () => {
    setError('');
    try {
      const result = await runMarketQuestionRewards();
      setRewardsResult(result);
    } catch (e) {
      setError(e?.message || 'FAILED TO RUN REWARDS');
    }
  };

  return (
    <div class="text-xs flex flex-col gap-2">
      <Show when={loading()}>
        <div class="text-bb-muted animate-pulse">LOADING QUEUE...</div>
      </Show>
      <Show when={loaded() && !loading() && queue().length === 0}>
        <div class="text-bb-muted">NO PENDING REVIEWS</div>
      </Show>
      <div class="flex flex-col gap-2">
        <For each={queue()}>
          {(item) => (
            <div class="border border-bb-border/40 p-2 flex flex-col gap-1">
              <div class="font-bold truncate">{item.title || `SUBMISSION #${item.id}`}</div>
              <div class="text-bb-muted">
                CREATOR: {item.creator_username || `USER #${item.creator_user_id}`} // APPROVALS: {item.approvals || 0}/{item.required_approvals ?? '--'}
              </div>
              <div class="flex items-center gap-2 mt-1">
                <button
                  type="button"
                  data-testid="admin-review-approve"
                  disabled={busyId() === item.id}
                  onClick={() => vote(item.id, 'approve')}
                  class="px-2 py-1 border border-market-up text-market-up hover:bg-market-up/20 disabled:opacity-50 uppercase font-bold"
                >
                  [APPROVE]
                </button>
                <button
                  type="button"
                  data-testid="admin-review-reject"
                  disabled={busyId() === item.id}
                  onClick={() => vote(item.id, 'reject')}
                  class="px-2 py-1 border border-market-down text-market-down hover:bg-market-down/20 disabled:opacity-50 uppercase font-bold"
                >
                  [REJECT]
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
      <div class="flex items-center gap-3 mt-2 border-t border-bb-border/40 pt-2">
        <button
          type="button"
          data-testid="admin-review-run-rewards"
          onClick={runRewards}
          class="px-3 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent uppercase font-bold"
        >
          [RUN REWARDS]
        </button>
        <Show when={success()}>
          <span class="text-market-up">{success()}</span>
        </Show>
        <Show when={error()}>
          <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
        </Show>
      </div>
      <Show when={rewardsResult()}>
        <pre class="mt-2 p-2 border border-bb-border/40 bg-bb-bg/40 overflow-x-auto whitespace-pre-wrap break-words">
          {JSON.stringify(rewardsResult(), null, 2)}
        </pre>
      </Show>
    </div>
  );
}

function MaintenanceSection() {
  const [weeklyResult, setWeeklyResult] = createSignal(null);
  const [persuasionResult, setPersuasionResult] = createSignal(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const runWeeklyAll = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.weekly.runAll();
      setWeeklyResult(result);
    } catch (e) {
      setError(e?.message || 'FAILED TO RUN WEEKLY PROCESSES');
    } finally {
      setBusy(false);
    }
  };

  const runPersuasionRewards = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.persuasion.runRewards();
      setPersuasionResult(result);
    } catch (e) {
      setError(e?.message || 'FAILED TO RUN PERSUASION REWARDS');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="text-xs flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <button
          type="button"
          data-testid="admin-maint-weekly"
          disabled={busy()}
          onClick={runWeeklyAll}
          class="px-3 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent disabled:opacity-50 uppercase font-bold"
        >
          [RUN WEEKLY ALL]
        </button>
        <button
          type="button"
          data-testid="admin-maint-persuasion"
          disabled={busy()}
          onClick={runPersuasionRewards}
          class="px-3 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent disabled:opacity-50 uppercase font-bold"
        >
          [RUN PERSUASION REWARDS]
        </button>
        <Show when={error()}>
          <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
        </Show>
      </div>
      <Show when={weeklyResult()}>
        <div>
          <div class="text-bb-muted uppercase mb-1">WEEKLY RUN-ALL RESULT</div>
          <pre class="p-2 border border-bb-border/40 bg-bb-bg/40 overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(weeklyResult(), null, 2)}
          </pre>
        </div>
      </Show>
      <Show when={persuasionResult()}>
        <div>
          <div class="text-bb-muted uppercase mb-1">PERSUASION REWARDS RESULT</div>
          <pre class="p-2 border border-bb-border/40 bg-bb-bg/40 overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(persuasionResult(), null, 2)}
          </pre>
        </div>
      </Show>
    </div>
  );
}

export default function AdminView() {
  const [eventsRefresh, setEventsRefresh] = createSignal(0);

  // Defense in depth: routing + palette already skip this view for
  // non-admins (TerminalApp's applyRoute/palette filter check isAdmin()),
  // but the view guards itself too in case it is ever reached another way.
  // isAdmin() reads getTokenData(), which reads the reactive `token` signal
  // from tokenService, so this Show re-evaluates whenever the token changes
  // (e.g. an admin logging in mid-session) instead of only at first render.
  return (
    <Show
      when={isAdmin()}
      fallback={(
        <div class="p-4 font-mono text-xs text-market-down uppercase" data-testid="admin-guard">
          ADMIN ONLY
        </div>
      )}
    >
      <div class="font-mono text-sm">
        <Section title="CREATE EVENT">
          <CreateEventSection onCreated={() => setEventsRefresh((v) => v + 1)} />
        </Section>
        <Section title="RESOLVE MARKET">
          <ResolveMarketSection refreshToken={eventsRefresh} />
        </Section>
        <Section title="REVIEW QUEUE"><ReviewQueueSection /></Section>
        <Section title="MAINTENANCE"><MaintenanceSection /></Section>
      </div>
    </Show>
  );
}
