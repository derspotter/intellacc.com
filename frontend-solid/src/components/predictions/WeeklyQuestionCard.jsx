import { createResource, Show } from 'solid-js';
import { api } from '../../services/api';
import { getCurrentUserId } from '../../services/auth';

/**
 * Fetch the caller's current weekly assignment status.
 * Returns null on any error so the home page never crashes.
 */
const fetchWeeklyStatus = async (userId) => {
  if (!userId) return null;
  try {
    const response = await api.weekly.getUserStatus(userId);
    if (!response?.success) return null;
    return response;
  } catch {
    return null;
  }
};

export default function WeeklyQuestionCard() {
  const userId = getCurrentUserId();
  const [status] = createResource(() => userId || null, fetchWeeklyStatus);

  // Show only when there is an OPEN, uncompleted assignment with a target event.
  const assignment = () => status()?.assignment || null;
  const isOpen = () => {
    const a = assignment();
    if (!a || !a.event_id) return false;
    return !(status()?.isCompleted || a.weekly_assignment_completed);
  };

  const title = () => {
    const a = assignment();
    if (!a) return '';
    return a.event_title || `Event #${a.event_id}`;
  };

  const goStake = () => {
    const a = assignment();
    if (!a?.event_id) return;
    window.location.hash = `predictions/${a.event_id}`;
  };

  return (
    <Show when={isOpen()}>
      <div class="weekly-question-card">
        <div class="label">Your weekly question</div>
        <p class="weekly-question-title">{title()}</p>
        <button type="button" class="post-action" onClick={goStake}>
          Stake now
        </button>
      </div>
    </Show>
  );
}
