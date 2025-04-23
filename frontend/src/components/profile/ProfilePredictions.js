import van from 'vanjs-core';
import * as vanX from 'vanjs-ext';
const { div, p, span } = van.tags;
import Card from '../common/Card';
import Button from '../common/Button';
import predictionsStore from '../../store/predictions';

/**
 * Predictions display component - simplified version
 * Used in both profile view and predictions page with identical appearance
 * 
 * @param {Object} props - Component properties
 * @param {number} [props.limit=5] - Limit the number of predictions shown (null = no limit)
 * @param {boolean} [props.showViewAll=true] - Whether to show the View All button
 * @param {string} [props.title='Your Predictions'] - Card title
 * @param {string} [props.className=''] - Additional CSS classes
 */
export default function ProfilePredictions(props = {}) {
  // Default props with VanX
  const config = vanX.reactive({
    limit: props.limit !== undefined ? props.limit : 5,
    showViewAll: props.showViewAll !== undefined ? props.showViewAll : true,
    title: props.title || 'Your Predictions',
    className: props.className || ''
  });
  
  // Fetch predictions if needed - the action handles avoiding re-fetches
  predictionsStore.actions.fetchPredictions.call(predictionsStore);
  
  // Reference store state for reactivity
  const predictions = predictionsStore.state.predictions;
  const loading = predictionsStore.state.loading;

  return Card({
    title: config.title,
    className: `predictions-list ${config.className}`,
    children: [
      // Loading state
      () => loading.val ? p("Loading predictions...") : null,
      
      // Empty state
      () => !loading.val && predictions.val.length === 0 ? 
        p("You haven't made any predictions yet.") : null,
      
      // Predictions list
      () => !loading.val && predictions.val.length > 0 ? (() => {
        // Apply limit if specified
        const items = config.limit ? predictions.val.slice(0, config.limit) : predictions.val;
        
        // Always use the compact prediction item style
        return div({ class: "prediction-list-compact" }, 
          items.map(prediction => 
            div({ 
              class: `prediction-item ${prediction.outcome ? 'resolved' : 'pending'}`,
              'data-outcome': prediction.outcome
            }, [
              div({ class: "prediction-event" }, prediction.event || prediction.title || "Unknown event"),
              div({ class: "prediction-details" }, [
                span(`${prediction.prediction_value} (${prediction.confidence}%)`),
                prediction.outcome ? 
                  span({ class: `outcome ${prediction.outcome}` }, prediction.outcome) :
                  span({ class: "pending" }, "Pending")
              ])
            ])
          )
        );
      })() : null,
      
      // View all button - only shown if showViewAll is true and we have predictions
      () => config.showViewAll && !loading.val && predictions.val.length > 0 ?
        Button({
          onclick: () => { window.location.hash = 'predictions'; },
          className: "view-all-button",
          variant: "primary",
          children: "View All Predictions"
        }) : null
    ]
  });
}