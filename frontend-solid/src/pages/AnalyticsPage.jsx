import PredictionAnalyticsDashboard from '../components/predictions/PredictionAnalyticsDashboard';
import RPBalance from '../components/predictions/RPBalance';

export default function AnalyticsPage() {
  return (
    <section class="predictions-page analytics-page">
      <h1>Prediction Analytics</h1>
      <div class="predictions-header">
        <RPBalance horizontal />
      </div>
      <div class="predictions-main">
        <PredictionAnalyticsDashboard />
      </div>
    </section>
  );
}
