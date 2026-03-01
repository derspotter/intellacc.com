import { Show, createSignal } from 'solid-js';
import EventsList from '../components/predictions/EventsList';
import LeaderboardCard from '../components/predictions/LeaderboardCard';
import MarketQuestionHub from '../components/predictions/MarketQuestionHub';
import AdminEventManagement from '../components/predictions/AdminEventManagement';
import RPBalance from '../components/predictions/RPBalance';
import { createEvent, resolveEvent } from '../services/api';
import { isAdmin, isAuthenticated } from '../services/auth';

const VERIFICATION_NOTICE_KEY = 'verificationNotice';

export default function PredictionsPage() {
  const [verificationNotice, setVerificationNotice] = createSignal(
    localStorage.getItem(VERIFICATION_NOTICE_KEY) || ''
  );

  const handleCreateEvent = async (payload) => {
    const { title, details, closing_date: closingDate } = payload || {};
    if (!isAuthenticated()) {
      return;
    }

    return createEvent(title, details, closingDate);
  };

  const handleResolveEvent = async (eventId, outcome) => {
    return resolveEvent(eventId, outcome);
  };

  const handleVerificationNotice = (message = '') => {
    const normalized = String(message || '').trim();
    if (!normalized) {
      localStorage.removeItem(VERIFICATION_NOTICE_KEY);
      setVerificationNotice('');
      return;
    }
    localStorage.setItem(VERIFICATION_NOTICE_KEY, normalized);
    setVerificationNotice(normalized);
  };

  return (
    <section class="predictions-page">
      <h1>Predictions & Betting</h1>

      <Show when={verificationNotice()}>
        <div class="predictions-phone-banner">{verificationNotice()}</div>
      </Show>

      <div class="predictions-header">
        <RPBalance horizontal />
      </div>

      <div class="predictions-main">
        <div class="predictions-top-grid">
          <div class="events-list-column">
            <EventsList
              createEvent={handleCreateEvent}
              onResolve={handleResolveEvent}
              onVerificationNotice={handleVerificationNotice}
            />
          </div>
        </div>

        <MarketQuestionHub />

        <Show when={isAdmin()}>
          <AdminEventManagement />
        </Show>

        <div class="predictions-bottom-leaderboard">
          <LeaderboardCard />
        </div>
      </div>
    </section>
  );
}
