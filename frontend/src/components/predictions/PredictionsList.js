import van from 'vanjs-core';
const { div, p } = van.tags;
const { derive } = van; // Import derive
import PredictionItem from './PredictionItem';
import predictionsStore from '../../store/predictions';  // Direct store import
// import { currentPageState } from '../../store/index'; // No longer needed here
import Card from '../common/Card'; // Import Card component

/**
 * List of user predictions, wrapped in a Card.
 * Assumes data fetching is handled elsewhere (e.g., router).
 */
export default function PredictionsList() {
  // Store state references for cleaner code
  const predictions = predictionsStore.state.predictions;
  const loading = predictionsStore.state.loading; // Still uses the generic loading flag

  // Fetch logic removed - handled by router

  // Create a derived state for the list content
  const listContent = derive(() => {
    console.log(`Deriving listContent: loading=${loading.val}, predictions.length=${predictions.val.length}`); // Add log
    if (loading.val) {
      return p("Loading predictions...");
    }
    if (predictions.val.length === 0) {
      return p("You haven't made any predictions yet.");
    }
    // Render the grid if not loading and predictions exist
    return div({ class: "predictions-grid" },
      predictions.val.map(prediction => {
        // console.log("Rendering PredictionItem for:", prediction); // Optional: Keep or remove inner log
        return PredictionItem({ prediction });
      })
    );
  });

  return Card({ // Use Card component as the root
    title: "Your Predictions", // Pass title to Card
    className: "predictions-list-card", // Add specific class if needed
    children: [
      listContent // Use the derived state directly as a child
    ] // End Card children
  }); // End Card component
}