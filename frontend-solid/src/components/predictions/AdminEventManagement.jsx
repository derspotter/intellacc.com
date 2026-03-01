import { createSignal, For, onMount } from 'solid-js';
import { createPrediction, getEvents } from '../../services/api';
import Card from '../common/Card';

export default function AdminEventManagement() {
  const [events, setEvents] = createSignal([]);
  const [selectedEventId, setSelectedEventId] = createSignal('');
  const [prediction, setPrediction] = createSignal('');
  const [confidence, setConfidence] = createSignal(50);
  const [submitting, setSubmitting] = createSignal(false);
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
      setEvents(Array.isArray(nextEvents) ? nextEvents : []);
    } catch (err) {
      setError(err?.message || 'Failed to load events.');
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    void loadEvents();
  });

  const handleSubmit = async (eventTarget) => {
    eventTarget.preventDefault?.();
    clearMessages();

    if (!selectedEventId()) {
      setError('Please select an event');
      return;
    }
    if (!prediction()) {
      setError('Please select your prediction');
      return;
    }

    setSubmitting(true);
    try {
      await createPrediction(selectedEventId(), prediction(), Number(confidence()), 'binary');
      setSelectedEventId('');
      setPrediction('');
      setConfidence(50);
      setMessage('Prediction created successfully!');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setError(err?.message || 'Failed to create prediction.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card title="Make a New Prediction" className="prediction-form">
      {error() ? <div class="error-message">{error()}</div> : null}
      {message() ? <div class="success-message">{message()}</div> : null}

      <form onSubmit={handleSubmit}>
        <div class="form-group">
          <label for="event">Select Event:</label>
          {loading() ? (
            <div class="loading-events">
              <span>Loading events...</span>
            </div>
          ) : (
            <select
              id="event"
              required
              disabled={submitting()}
              value={selectedEventId()}
              onChange={(eventTarget) => setSelectedEventId(eventTarget.currentTarget.value)}
            >
              <option value="">-- Select an event --</option>
              <For each={events()}>
                {(eventItem) => (
                  <option value={eventItem.id}>{eventItem.title}</option>
                )}
              </For>
            </select>
          )}
        </div>

        <div class="form-group">
          <label for="prediction">Your Prediction:</label>
          <select
            id="prediction"
            required
            disabled={submitting()}
            value={prediction()}
            onChange={(eventTarget) => setPrediction(eventTarget.currentTarget.value)}
          >
            <option value="">-- Select your prediction --</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        </div>

        <div class="form-group">
          <label for="confidence">
            Confidence:
            <span class="confidence-value"> {confidence()}%</span>
          </label>
          <input
            type="range"
            id="confidence"
            min="1"
            max="100"
            step="1"
            disabled={submitting()}
            value={confidence()}
            onInput={(eventTarget) => setConfidence(Number(eventTarget.currentTarget.value))}
          />
        </div>

        <div class="form-actions">
          <button
            type="submit"
            class="button submit-button"
            disabled={submitting()}
          >
            {submitting() ? 'Submitting...' : 'Submit Prediction'}
          </button>
        </div>
      </form>
    </Card>
  );
}
