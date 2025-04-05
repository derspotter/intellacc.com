import van from 'vanjs-core';
const { div, h3, p } = van.tags;
import PredictionItem from './PredictionItem';
import predictionsStore from '../../store/predictions';  // Direct store import

/**
 * List of user predictions
 */
export default function PredictionsList() {
  // Store state references for cleaner code
  const predictions = predictionsStore.state.predictions;
  const loading = predictionsStore.state.loading;
  
  // Fetch predictions - the action will handle avoiding duplicates/re-fetches
  setTimeout(() => predictionsStore.actions.fetchPredictions.call(predictionsStore), 0);
  
  return div({ class: "predictions-list" }, [
    // Header with title and refresh button
    div({ class: "predictions-header" }, [
      h3("Your Predictions"),
      
      // Improved refresh button
      van.tags.button({
        class: "refresh-button",
        onclick: async () => {
          try {
            await predictionsStore.actions.fetchPredictions.call(predictionsStore);
          } catch (error) {
            console.error("Failed to refresh predictions:", error);
          }
        },
        title: "Refresh predictions",
        style: `
          background: transparent;
          border: none;
          cursor: pointer;
          font-size: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 5px;
        `
      }, "⟳")
    ]),
    
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
      ) : null

  ]);
}