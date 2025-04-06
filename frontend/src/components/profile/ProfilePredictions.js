import van from 'vanjs-core';
const { div, h3, p, span } = van.tags;
import Card from '../common/Card';
import Button from '../common/Button';
import predictionsStore from '../../store/predictions';

/**
 * Component to display predictions on profile page
 */
export default function ProfilePredictions() {
  // Fetch predictions if needed - the action handles avoiding re-fetches
  setTimeout(() => predictionsStore.actions.fetchPredictions.call(predictionsStore), 0);
  
  return Card({
    title: "Your Predictions",
    className: "profile-predictions",
    children: [
      // Loading state
      () => predictionsStore.state.loading.val ? 
        p("Loading predictions...") : null,
      
      // Empty state
      () => !predictionsStore.state.loading.val && predictionsStore.state.predictions.val.length === 0 ? 
        p("You haven't made any predictions yet.") : null,
      
      // Predictions preview (top 5)
      () => !predictionsStore.state.loading.val && predictionsStore.state.predictions.val.length > 0 ? 
        div({ class: "prediction-list-compact" }, 
          predictionsStore.state.predictions.val.slice(0, 5).map(prediction => 
            div({ 
              class: `prediction-item ${prediction.outcome ? 'resolved' : 'pending'}`,
              'data-outcome': prediction.outcome
            }, [
              div({ class: "prediction-event" }, prediction.event),
              div({ class: "prediction-details" }, [
                span(`${prediction.prediction_value} (${prediction.confidence}%)`),
                prediction.outcome ? 
                  span({ class: `outcome ${prediction.outcome}` }, prediction.outcome) :
                  span({ class: "pending" }, "Pending")
              ])
            ])
          )
        ) : null,
      
      // View all button
      Button({
        onclick: () => { window.location.hash = 'predictions'; },
        className: "view-all-button"
      }, "View All Predictions")
    ]
  });
}