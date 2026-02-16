import van from 'vanjs-core';
import RPBalance from '../components/predictions/RPBalance.js';
import EventsList from '../components/predictions/EventsList.js';
import AdminEventManagement from '../components/predictions/AdminEventManagement.js';
import MarketQuestionHub from '../components/predictions/MarketQuestionHub.js';
import LeaderboardCard from '../components/predictions/LeaderboardCard.js';
import { isAdminState } from '../services/auth.js';
import predictionsStore from '../store/predictions.js';

const { div, h1 } = van.tags;

const buildPredictionsPage = () => {
  const balancePanel = RPBalance({ horizontal: true });
  const eventsList = EventsList();
  const marketQuestionHub = MarketQuestionHub();
  const leaderboard = LeaderboardCard();

  return div({ class: 'predictions-page' }, [
    h1('Predictions & Betting'),
    () => {
      const msg = predictionsStore.state.verificationNotice?.val;
      if (!msg) return null;
      return div({ class: 'predictions-phone-banner' }, msg);
    },
    div({ class: 'predictions-header' }, [
      balancePanel
    ]),
    div({ class: 'predictions-main' }, [
        div({ class: 'predictions-top-grid' }, [
          div({ class: 'events-list-column' }, [eventsList])
        ]),
        marketQuestionHub,
        () => isAdminState.val ? AdminEventManagement() : null,
        div({ class: 'predictions-bottom-leaderboard' }, [leaderboard])
      ]),
  ]);
};

let predictionsPageInstance = null;

export default function PredictionsPage() {
  if (!predictionsPageInstance) {
    predictionsPageInstance = buildPredictionsPage();
  }
  return predictionsPageInstance;
}
