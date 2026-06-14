import { createSignal, For, onMount, Show } from 'solid-js';
import { getEvents, resolveEvent } from '../../services/api';
import Card from '../common/Card';

// Admin-only market resolution. Lives in the admin section of the predictions
// page (not inline on the public market card, where it used to leak to admins
// while trading). Lists unresolved markets, picks an outcome, and resolves.
export default function AdminMarketResolution() {
  const [events, setEvents] = createSignal([]);
  const [selectedEventId, setSelectedEventId] = createSignal('');
  const [outcome, setOutcome] = createSignal('yes');
  const [resolving, setResolving] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  const clearMessages = () => {
    setError('');
    setMessage('');
  };

  const loadEvents = async () => {
    setLoading(true);
    clearMessages();
    try {
      const nextEvents = await getEvents('');
      // Only markets that are not yet resolved can be resolved.
      const unresolved = (Array.isArray(nextEvents) ? nextEvents : []).filter((e) => !e.outcome);
      setEvents(unresolved);
    } catch (err) {
      setError(err?.message || 'Failed to load events.');
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    void loadEvents();
  });

  const handleResolve = async (submitEvent) => {
    submitEvent?.preventDefault?.();
    clearMessages();

    if (!selectedEventId()) {
      setError('Please select a market to resolve.');
      return;
    }

    setResolving(true);
    try {
      await resolveEvent(selectedEventId(), outcome());
      setMessage(`Market resolved as ${outcome().toUpperCase()}.`);
      setSelectedEventId('');
      setOutcome('yes');
      await loadEvents();
      setTimeout(() => setMessage(''), 4000);
    } catch (err) {
      setError(err?.message || 'Failed to resolve market.');
    } finally {
      setResolving(false);
    }
  };

  return (
    <Card title="Resolve Market" className="market-resolution-form">
      {error() ? <div class="error-message">{error()}</div> : null}
      {message() ? <div class="success-message">{message()}</div> : null}

      <form onSubmit={handleResolve}>
        <div class="form-group">
          <label for="resolve-event">Select Market:</label>
          {loading() ? (
            <div class="loading-events"><span>Loading markets...</span></div>
          ) : (
            <select
              id="resolve-event"
              required
              disabled={resolving()}
              value={selectedEventId()}
              onChange={(target) => setSelectedEventId(target.currentTarget.value)}
            >
              <option value="">-- Select a market --</option>
              <For each={events()}>
                {(eventItem) => (
                  <option value={eventItem.id}>{eventItem.title}</option>
                )}
              </For>
            </select>
          )}
        </div>

        <div class="form-group">
          <label>Outcome:</label>
          <div class="trade-direction">
            <button
              type="button"
              class={`button ${outcome() === 'no' ? 'active-trade-direction' : ''}`}
              onClick={() => setOutcome('no')}
              disabled={resolving()}
            >
              Resolve No
            </button>
            <button
              type="button"
              class={`button ${outcome() === 'yes' ? 'active-trade-direction' : ''}`}
              onClick={() => setOutcome('yes')}
              disabled={resolving()}
            >
              Resolve Yes
            </button>
          </div>
        </div>

        <div class="form-actions">
          <button type="submit" class="button submit-button" disabled={resolving() || !selectedEventId()}>
            {resolving() ? 'Resolving...' : 'Resolve market'}
          </button>
        </div>
      </form>

      <Show when={!loading() && events().length === 0}>
        <p class="muted">No unresolved markets.</p>
      </Show>
    </Card>
  );
}
