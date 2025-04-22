import van from 'vanjs-core';
const { div, h3, p } = van.tags;
import PredictionItem from './PredictionItem';
import predictionsStore from '../../store/predictions';  // Direct store import
import Button from '../common/Button';

/**
 * List of user predictions
 */
export default function PredictionsList() {
  // Store state references for cleaner code
  const predictions = predictionsStore.state.predictions;
  const loading = predictionsStore.state.loading;
  
  // Fetch predictions if needed
  if (predictions.val.length === 0 && !loading.val) {
    setTimeout(() => predictionsStore.actions.fetchPredictions.call(predictionsStore), 0);
  }
  
  return div({ class: "predictions-list" }, [
    h3("Your Predictions"),
    
    // Loading state
    () => loading.val ? 
      p("Loading predictions...") : null,
    
    // Empty state
    () => !loading.val && predictions.val.length === 0 ? 
      p("You haven't made any predictions yet.") : null,
    
    // Predictions list
    () => !loading.val && predictions.val.length > 0 ? 
      div({ class: "predictions-grid" }, 
        predictions.val.map(prediction => 
          PredictionItem({ prediction })
        )
      ) : null,
      
    // Refresh button
    Button({
      onclick: () => predictionsStore.actions.fetchPredictions.call(predictionsStore),
      className: "refresh-button"
    }, "↻ Refresh")
  ]);
}