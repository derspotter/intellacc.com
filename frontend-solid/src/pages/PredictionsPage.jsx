import { Show, createSignal, createMemo } from 'solid-js';
import EventsList from '../components/predictions/EventsList';
import LeaderboardCard from '../components/predictions/LeaderboardCard';
import MarketQuestionHub from '../components/predictions/MarketQuestionHub';
import AdminEventManagement from '../components/predictions/AdminEventManagement';
import AdminMarketResolution from '../components/predictions/AdminMarketResolution';
import AdminTools from '../components/predictions/AdminTools';
import RPBalance from '../components/predictions/RPBalance';
import { createEvent } from '../services/api';
import { isAdmin, isAuthenticated } from '../services/auth';

const VERIFICATION_NOTICE_KEY = 'verificationNotice';

export default function PredictionsPage(props) {
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

  // The hash segment after `predictions/` is either a reserved tab keyword,
  // a numeric market id (deep-link to expand on the Markets tab), or empty.
  const activeTab = createMemo(() => {
    const param = String(props.marketId || '').trim().toLowerCase();
    if (param === 'submit') return 'submit';
    if (param === 'leaderboard') return 'leaderboard';
    if (param === 'admin' && isAdmin()) return 'admin';
    return 'markets';
  });

  const targetedMarketId = createMemo(() => {
    const param = String(props.marketId || '').trim();
    return /^\d+$/.test(param) ? param : null;
  });

  const goToTab = (tab) => {
    window.location.hash = tab === 'markets' ? 'predictions' : `predictions/${tab}`;
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

      <nav class="predictions-tabs" role="tablist">
        <button type="button" role="tab" class={`predictions-tab ${activeTab() === 'markets' ? 'on' : ''}`} aria-selected={activeTab() === 'markets'} onClick={() => goToTab('markets')}>Markets</button>
        <button type="button" role="tab" class={`predictions-tab ${activeTab() === 'submit' ? 'on' : ''}`} aria-selected={activeTab() === 'submit'} onClick={() => goToTab('submit')}>Submit</button>
        <button type="button" role="tab" class={`predictions-tab ${activeTab() === 'leaderboard' ? 'on' : ''}`} aria-selected={activeTab() === 'leaderboard'} onClick={() => goToTab('leaderboard')}>Leaderboard</button>
        <Show when={isAdmin()}>
          <button type="button" role="tab" class={`predictions-tab ${activeTab() === 'admin' ? 'on' : ''}`} aria-selected={activeTab() === 'admin'} onClick={() => goToTab('admin')}>Admin</button>
        </Show>
      </nav>

      <div class="predictions-main">
        <Show when={activeTab() === 'markets'}>
          <div class="predictions-top-grid">
            <div class="events-list-column">
              <EventsList
                targetedMarketId={targetedMarketId()}
                createEvent={handleCreateEvent}
                onVerificationNotice={handleVerificationNotice}
              />
            </div>
          </div>
        </Show>

        <Show when={activeTab() === 'submit'}>
          <MarketQuestionHub />
        </Show>

        <Show when={activeTab() === 'leaderboard'}>
          <div class="predictions-bottom-leaderboard">
            <LeaderboardCard />
          </div>
        </Show>

        <Show when={activeTab() === 'admin' && isAdmin()}>
          <AdminTools />
          <AdminMarketResolution />
          <AdminEventManagement />
        </Show>
      </div>
    </section>
  );
}
