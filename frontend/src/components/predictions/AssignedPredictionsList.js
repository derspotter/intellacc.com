import van from 'vanjs-core';
const { div, h3, p, span, form, label, select, option, input } = van.tags;
import Card from '../common/Card';
import Button from '../common/Button';
import predictionsStore from '../../store/predictions';  // Direct store import

// Initialization flags
let assignedPredictionsInitialized = false;
let bettingStatsInitialized = false;

/**
 * Component for assigned predictions that need betting
 */
export default function AssignedPredictionsList() {
  // Store state for easier references
  const assignedPredictions = predictionsStore.state.assignedPredictions;
  const bettingStats = predictionsStore.state.bettingStats;
  
  // Bet form state
  const betFormState = van.state({
    assignmentId: null,
    prediction: null,
    confidenceLevel: 5,
    betOn: '',
    submitting: false,
    error: '',
    success: ''
  });
  
  // Fetch assigned predictions only once if needed
  if (assignedPredictions.val.length === 0 && !assignedPredictionsInitialized) {
    assignedPredictionsInitialized = true;
    setTimeout(() => {
      predictionsStore.actions.fetchAssignedPredictions.call(predictionsStore);
    }, 0);
  }
  
  // Fetch betting stats only once if needed
  if (!bettingStats.val.remaining_bets && !bettingStatsInitialized) {
    bettingStatsInitialized = true;
    setTimeout(() => {
      predictionsStore.actions.fetchBettingStats.call(predictionsStore);
    }, 100); // Slight delay to stagger API calls
  }
  
  // Start betting on a prediction
  const startBet = (assignment) => {
    betFormState.val = {
      ...betFormState.val,
      assignmentId: assignment.id,
      prediction: assignment,
      betOn: '',
      error: '',
      success: ''
    };
  };
  
  // Cancel betting
  const cancelBet = () => {
    betFormState.val = {
      ...betFormState.val,
      assignmentId: null,
      prediction: null,
      betOn: '',
      error: '',
      success: ''
    };
  };
  
  // Submit bet
  const submitBet = async (e) => {
    e.preventDefault();
    
    if (!betFormState.val.betOn) {
      betFormState.val = {...betFormState.val, error: 'Please select your bet'};
      return;
    }
    
    betFormState.val = {...betFormState.val, submitting: true, error: ''};
    
    try {
      await predictionsStore.actions.placeBet.call(predictionsStore,
        betFormState.val.assignmentId,
        betFormState.val.confidenceLevel,
        betFormState.val.betOn
      );
      
      betFormState.val = {
        assignmentId: null,
        prediction: null,
        confidenceLevel: 5,
        betOn: '',
        submitting: false,
        error: '',
        success: 'Bet placed successfully!'
      };
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        betFormState.val = {...betFormState.val, success: ''};
      }, 3000);
    } catch (error) {
      betFormState.val = {
        ...betFormState.val, 
        submitting: false, 
        error: error.message || 'Failed to place bet'
      };
    }
  };
  
  // Bet form component
  const BetForm = () => {
    if (!betFormState.val.assignmentId) return null;
    
    return Card({
      title: "Place Your Bet",
      className: "bet-form",
      children: [
        // Prediction info
        div({ class: "prediction-info" }, [
          div({ class: "prediction-event" }, betFormState.val.prediction.event),
          div({ class: "prediction-original" }, [
            "Original prediction: ",
            span({ class: "value" }, betFormState.val.prediction.prediction_value)
          ])
        ]),
        
        // Error/success message
        () => betFormState.val.error ? 
          div({ class: "error-message" }, betFormState.val.error) : null,
        () => betFormState.val.success ? 
          div({ class: "success-message" }, betFormState.val.success) : null,
        
        // Bet form
        form({ onsubmit: submitBet }, [
          div({ class: "form-group" }, [
            label({ for: "betOn" }, "Your Bet:"),
            select({
              id: "betOn",
              required: true,
              disabled: betFormState.val.submitting,
              value: betFormState.val.betOn,
              onchange: (e) => betFormState.val = {
                ...betFormState.val, 
                betOn: e.target.value
              }
            }, [
              option({ value: "" }, "-- Select your bet --"),
              option({ value: "yes" }, "Yes"),
              option({ value: "no" }, "No")
            ])
          ]),
          
          div({ class: "form-group" }, [
            label({ for: "confidenceLevel" }, [
              "Confidence: ",
              span({ class: "confidence-value" }, `${betFormState.val.confidenceLevel}/10`)
            ]),
            input({
              type: "range",
              id: "confidenceLevel",
              min: "1",
              max: "10",
              step: "1",
              disabled: betFormState.val.submitting,
              value: betFormState.val.confidenceLevel,
              onchange: (e) => betFormState.val = {
                ...betFormState.val, 
                confidenceLevel: parseInt(e.target.value)
              }
            })
          ]),
          
          div({ class: "form-buttons" }, [
            Button({
              type: "submit",
              disabled: betFormState.val.submitting,
              className: "submit-button"
            }, betFormState.val.submitting ? "Submitting..." : "Place Bet"),
            Button({
              type: "button",
              onclick: cancelBet,
              disabled: betFormState.val.submitting,
              className: "cancel-button"
            }, "Cancel")
          ])
        ])
      ]
    });
  };
  
  // Monthly stats component
  const MonthlyStats = () => 
    Card({
      title: "Monthly Betting Stats",
      className: "monthly-stats",
      children: [
        p([
          `Completed bets: ${bettingStats.val.completed_bets}/${bettingStats.val.total_assigned || 5}`,
          span({ class: "stat-highlight" }, 
            ` (${bettingStats.val.remaining_bets} remaining)`
          )
        ])
      ]
    });
  
  return div({ class: "assigned-predictions" }, [
    h3("Your Assigned Predictions"),
    
    // Monthly stats
    MonthlyStats(),
    
    // Bet form (if active)
    () => betFormState.val.assignmentId ? BetForm() : null,
    
    // List of assigned predictions
    () => assignedPredictions.val.length === 0 ? 
      p("No assigned predictions for this month.") :
      div({ class: "prediction-list" }, 
        assignedPredictions.val.map(assignment => 
          Card({
            className: "prediction-card",
            children: [
              h3({ class: "prediction-event" }, assignment.event),
              p({ class: "prediction-original" }, 
                `Original prediction: ${assignment.prediction_value}`
              ),
              p({ class: "prediction-date" }, 
                `Assigned on: ${new Date(assignment.assigned_at).toLocaleDateString()}`
              ),
              Button({
                className: "bet-button",
                onclick: () => startBet(assignment)
              }, "Place Bet")
            ]
          })
        )
      )
  ]);
}