import { createSignal, Show, onMount } from 'solid-js';
import Card from '../common/Card';
import api from '../../services/api';

export default function AdminTools() {
  const [submitting, setSubmitting] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');

  // Event creation form state
  const [title, setTitle] = createSignal('');
  const [details, setDetails] = createSignal('');
  const [closingDate, setClosingDate] = createSignal('');

  const clearMessages = () => {
    setError('');
    setMessage('');
  };

  const handleCreateEvent = async (e) => {
    e.preventDefault();
    clearMessages();

    if (!title().trim()) {
      setError('Please enter an event title');
      return;
    }
    if (!closingDate()) {
      setError('Please select a closing date');
      return;
    }

    setSubmitting(true);
    try {
      await api.events.create({
        title: title().trim(),
        details: details().trim(),
        closing_date: closingDate()
      });
      setTitle('');
      setDetails('');
      setClosingDate('');
      setMessage('Event created successfully!');
      setTimeout(() => setMessage(''), 5000);
    } catch (err) {
      setError(err?.message || 'Failed to create event');
    } finally {
      setSubmitting(false);
    }
  };

  const runTask = async (taskName, taskFn) => {
    clearMessages();
    setSubmitting(true);
    try {
      setMessage(`Running ${taskName}...`);
      const result = await taskFn();
      setMessage(`${taskName} complete: ${JSON.stringify(result || 'Success')}`);
    } catch (err) {
      setError(`${taskName} failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="admin-tools">
      <Card title="Admin Tools" className="admin-tools-card">
        <Show when={error()}>
          <div class="error-message">{error()}</div>
        </Show>
        <Show when={message()}>
          <div class="success-message">{message()}</div>
        </Show>

        <section class="admin-section">
          <h4>Create New Event</h4>
          <form onSubmit={handleCreateEvent}>
            <div class="form-group">
              <label for="event-title">Title:</label>
              <input
                id="event-title"
                type="text"
                value={title()}
                onInput={(e) => setTitle(e.target.value)}
                required
                disabled={submitting()}
              />
            </div>
            <div class="form-group">
              <label for="event-details">Details:</label>
              <textarea
                id="event-details"
                value={details()}
                onInput={(e) => setDetails(e.target.value)}
                disabled={submitting()}
              />
            </div>
            <div class="form-group">
              <label for="event-closing">Closing Date:</label>
              <input
                id="event-closing"
                type="datetime-local"
                value={closingDate()}
                onInput={(e) => setClosingDate(e.target.value)}
                required
                disabled={submitting()}
              />
            </div>
            <button type="submit" class="button primary" disabled={submitting()}>
              {submitting() ? 'Creating...' : 'Create Event'}
            </button>
          </form>
        </section>

        <hr />

        <section class="admin-section">
          <h4>Operations & Maintenance</h4>
          <div class="admin-buttons">
            <button 
              type="button" 
              class="button secondary" 
              onClick={() => runTask('Calculate Log Scores', api.scoring.calculateLogScores)}
              disabled={submitting()}
            >
              Recalculate Log Scores
            </button>
            <button 
              type="button" 
              class="button secondary" 
              onClick={() => runTask('Run Weekly All', api.weekly.runAll)}
              disabled={submitting()}
            >
              Run All Weekly Tasks
            </button>
            <button 
              type="button" 
              class="button secondary" 
              onClick={() => runTask('Persuasion Rewards', api.persuasion.runRewards)}
              disabled={submitting()}
            >
              Run Persuasion Rewards
            </button>
          </div>
        </section>
      </Card>
    </div>
  );
}
