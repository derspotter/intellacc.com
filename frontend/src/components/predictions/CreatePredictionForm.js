// frontend/src/components/predictions/CreatePredictionForm.js
import van from 'vanjs-core';
import * as vanX from 'vanjs-ext';
const { div, form, select, option, label, input, span, button } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import predictionsStore from '../../store/predictions';
import { isLoggedInState } from '../../services/auth';

// Helper function to generate probability vectors for unified scoring
function generateProbabilityVector(prediction_type, prediction_value, confidence, numerical_value, lower_bound, upper_bound) {
  switch (prediction_type) {
    case 'binary':
      // Convert confidence to probability vector
      const prob = confidence / 100.0;
      if (prediction_value.toLowerCase() === 'yes' || prediction_value.toLowerCase() === 'true') {
        return [prob, 1 - prob]; // [P(Yes), P(No)]
      } else {
        return [1 - prob, prob]; // [P(Yes), P(No)]
      }
      
    case 'multiple_choice':
      // For now, create uniform distribution with higher weight on selected choice
      const numOptions = 4; // Default assumption
      const selectedProb = confidence / 100.0;
      const remainingProb = (1 - selectedProb) / (numOptions - 1);
      const probs = new Array(numOptions).fill(remainingProb);
      probs[0] = selectedProb; // Simplified - assume first option selected
      return probs;
      
    case 'numeric':
    case 'discrete':
      // For numerical predictions, store distribution parameters
      if (lower_bound !== null && upper_bound !== null) {
        return {
          type: 'interval',
          point_estimate: numerical_value,
          lower_bound: lower_bound,
          upper_bound: upper_bound,
          confidence: confidence / 100.0
        };
      } else {
        return {
          type: 'point',
          estimate: numerical_value,
          confidence: confidence / 100.0
        };
      }
      
    case 'date':
      return {
        type: 'date',
        predicted_date: prediction_value,
        confidence: confidence / 100.0
      };
      
    default:
      // Fallback to binary
      const fallbackProb = confidence / 100.0;
      return [fallbackProb, 1 - fallbackProb];
  }
}

/**
 * Form for creating new predictions - Ultra concise VanX implementation
 */
export default function CreatePredictionForm() {
  // Load initial events when component is created
  if (isLoggedInState.val && predictionsStore.state.events.val.length === 0) {
    predictionsStore.actions.fetchEvents.call(predictionsStore, '');
  }
  // --- Combined state ---
  const state = vanX.reactive({
    eventId: '',
    prediction: '',
    confidence: 50,
    submitting: false,
    error: '',
    success: '',
    displayMode: 'voluntary',
    searchTerm: '',
    showDropdown: false,
    selectedEventType: 'binary', // Track the type of selected event
    // Numerical prediction fields
    lowerBound: '',
    upperBound: ''
  });
  
  // --- Store References ---
  const { events, assignedPredictions, loadingEvents, loadingAssigned, predictions } = predictionsStore.state;

  // --- Search handlers with debouncing ---
  let searchTimeout;
  const handleSearch = async (searchTerm) => {
    state.searchTerm = searchTerm;
    state.eventId = ''; // Clear selection when searching
    
    if (state.displayMode === 'voluntary') {
      // Clear existing timeout
      if (searchTimeout) {
        clearTimeout(searchTimeout);
      }
      
      // Debounce search requests
      searchTimeout = setTimeout(async () => {
        console.log('Searching for:', searchTerm);
        await predictionsStore.actions.fetchEvents.call(predictionsStore, searchTerm);
      }, 300); // 300ms delay
    }
  };

  // --- Form submission ---
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!state.eventId || !state.prediction) {
      state.error = !state.eventId ? 'Please select an event' : 'Please select your prediction';
      return;
    }

    // Validate numerical predictions
    if ((state.selectedEventType === 'numeric' || state.selectedEventType === 'discrete') && 
        (!state.prediction || isNaN(parseFloat(state.prediction)))) {
      state.error = 'Please enter a valid numerical prediction';
      return;
    }

    // Validate interval bounds if provided
    if (state.lowerBound && state.upperBound && 
        parseFloat(state.lowerBound) >= parseFloat(state.upperBound)) {
      state.error = 'Lower bound must be less than upper bound';
      return;
    }

    state.submitting = true;
    state.error = '';
    
    try {
      // Generate probability vector on frontend for better UX and validation
      const prob_vector = generateProbabilityVector(
        state.selectedEventType,
        state.prediction,
        state.confidence,
        state.selectedEventType === 'numeric' || state.selectedEventType === 'discrete' ? parseFloat(state.prediction) : null,
        state.lowerBound ? parseFloat(state.lowerBound) : null,
        state.upperBound ? parseFloat(state.upperBound) : null
      );

      await predictionsStore.actions.createPrediction.call(
        predictionsStore, 
        state.eventId, 
        state.prediction, 
        state.confidence,
        state.selectedEventType,
        state.selectedEventType === 'numeric' || state.selectedEventType === 'discrete' ? parseFloat(state.prediction) : null,
        state.lowerBound ? parseFloat(state.lowerBound) : null,
        state.upperBound ? parseFloat(state.upperBound) : null,
        prob_vector
      );
      
      // Reset form
      state.eventId = state.prediction = '';
      state.lowerBound = state.upperBound = '';
      state.confidence = 50;
      state.searchTerm = '';
      state.selectedEventType = 'binary';
      state.success = 'Prediction created successfully!';
      setTimeout(() => state.success = '', 3000);
    } catch (err) {
      state.error = err.message || 'Failed to create prediction';
    } finally {
      state.submitting = false;
    }
  };

  return Card({
    title: "Make a New Prediction",
    className: "prediction-form",
    children: [
      // Toggle buttons
      div({ class: 'prediction-toggle-container' },
        ['voluntary', 'assigned'].map(mode => 
          button({
            class: () => `toggle-button ${state.displayMode === mode ? 'active' : ''}`,
            onclick: async () => { 
              state.displayMode = mode; 
              state.eventId = ''; 
              state.searchTerm = '';
              // Fetch events when switching to voluntary mode
              if (mode === 'voluntary' && isLoggedInState.val) {
                await predictionsStore.actions.fetchEvents.call(predictionsStore, '');
              }
            }
          }, mode.charAt(0).toUpperCase() + mode.slice(1))
        )
      ),

      // Feedback messages
      () => state.error && div({ class: "error-message" }, state.error),
      () => state.success && div({ class: "success-message" }, state.success),

      // Form
      form({ onsubmit: handleSubmit }, [
        // Event search and selection
        div({ class: "form-group" },
          label({ for: "event-search" }, () => `Search ${state.displayMode === 'voluntary' ? 'Events' : 'Assignments'}:`),
          
          // Conditionally render search input for voluntary predictions
          () => state.displayMode === 'voluntary' ? input({
            type: "text",
            id: "event-search",
            placeholder: "Search questions by keyword (e.g., 'bitcoin', 'trump', 'AI')...",
            value: () => state.searchTerm,
            oninput: e => handleSearch(e.target.value),
            disabled: state.submitting || !isLoggedInState.val,
            style: "width: 100%; padding: 8px; margin-bottom: 8px; border: 1px solid var(--border-color); border-radius: 4px;"
          }) : null,
          
          // Event selection dropdown - reactive based on search results
          () => {
            if (state.displayMode === 'voluntary') {
              const userPredictionEventIds = new Set(predictions.val.map(p => p.event_id));
              const availableEvents = events.val.filter(event => !userPredictionEventIds.has(event.id));
              
              return select({
                id: "event",
                required: true,
                onchange: e => {
                  state.eventId = e.target.value;
                  // Find selected event and extract its type
                  const selectedEvent = availableEvents.find(event => String(event.id) === e.target.value);
                  if (selectedEvent && selectedEvent.details) {
                    const typeMatch = selectedEvent.details.match(/Type: ([a-z_]+)/);
                    state.selectedEventType = typeMatch ? typeMatch[1] : 'binary';
                  } else {
                    state.selectedEventType = 'binary';
                  }
                  // Clear prediction when event changes
                  state.prediction = '';
                },
                disabled: state.submitting || !isLoggedInState.val,
                style: "margin-top: 8px;"
              }, [
                option({ value: '' }, "-- Select Event --"),
                
                // Status options
                !isLoggedInState.val ? option({ value: '', disabled: true }, "Please log in") :
                loadingEvents.val ? option({ value: '', disabled: true }, "Searching...") :
                availableEvents.length === 0 ? option(
                  { value: '', disabled: true },
                  state.searchTerm ? `No events found for "${state.searchTerm}"` : 'Type above to search events'
                ) : state.searchTerm ? option(
                  { value: '', disabled: true },
                  `Found ${availableEvents.length} event${availableEvents.length === 1 ? '' : 's'} for "${state.searchTerm}"`
                ) : null,
                
                // Map available events to options
                ...availableEvents.map(event => option({
                  value: String(event.id),
                  selected: () => state.eventId === String(event.id)
                }, event.title.length > 80 ? event.title.substring(0, 80) + '...' : event.title))
              ]);
            } else {
              // Assigned predictions dropdown (no search needed)
              return select({
                id: "event",
                required: true,
                onchange: e => state.eventId = e.target.value,
                disabled: state.submitting || !isLoggedInState.val
              }, [
                option({ value: '' }, "-- Select Assignment --"),
                
                !isLoggedInState.val ? option({ value: '', disabled: true }, "Please log in") :
                loadingAssigned.val ? option({ value: '', disabled: true }, "Loading...") :
                assignedPredictions.val.length === 0 ? option({ value: '', disabled: true }, 'No pending assignments') : null,
                
                ...assignedPredictions.val.map(item => option({
                  value: String(item.event_id),
                  selected: () => state.eventId === String(item.event_id)
                }, item.event || `Assignment ${item.id}`))
              ]);
            }
          }
        ),

        // Prediction input - dynamic based on event type
        div({ class: "form-group" },
          label({ for: "prediction" }, () => {
            switch(state.selectedEventType) {
              case 'numeric': return "Your Numerical Prediction:";
              case 'discrete': return "Your Numerical Prediction:";
              case 'multiple_choice': return "Your Choice:";
              case 'date': return "Your Date Prediction:";
              default: return "Your Prediction:";
            }
          }),
          
          // Dynamic input based on event type
          () => {
            switch(state.selectedEventType) {
              case 'numeric':
              case 'discrete':
                return input({
                  type: "number",
                  id: "prediction",
                  placeholder: "Enter a number",
                  value: () => state.prediction,
                  oninput: e => state.prediction = e.target.value,
                  disabled: state.submitting,
                  required: true,
                  step: "any",
                  style: "width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px;"
                });
                
              case 'date':
                return input({
                  type: "date",
                  id: "prediction",
                  value: () => state.prediction,
                  oninput: e => state.prediction = e.target.value,
                  disabled: state.submitting,
                  required: true,
                  style: "width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px;"
                });
                
              case 'multiple_choice':
                return input({
                  type: "text",
                  id: "prediction",
                  placeholder: "Enter your choice",
                  value: () => state.prediction,
                  oninput: e => state.prediction = e.target.value,
                  disabled: state.submitting,
                  required: true,
                  style: "width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px;"
                });
                
              default: // binary
                return select({
                  id: "prediction",
                  required: true,
                  onchange: e => state.prediction = e.target.value,
                  disabled: state.submitting
                }, [
                  option({ value: "" }, "-- Select your prediction --"),
                  ...["Yes", "No"].map(value => option({ 
                    value, 
                    selected: () => state.prediction === value 
                  }, value))
                ]);
            }
          }
        ),

        // Confidence interval for numerical predictions
        () => (state.selectedEventType === 'numeric' || state.selectedEventType === 'discrete') ? 
          div({ class: "form-group" },
            label("Confidence Interval (Optional):"),
            div({ style: "display: flex; gap: 8px; align-items: center;" }, [
              input({
                type: "number",
                placeholder: "Lower bound",
                value: () => state.lowerBound,
                oninput: e => state.lowerBound = e.target.value,
                disabled: state.submitting,
                step: "any",
                style: "flex: 1; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px;"
              }),
              span({ style: "padding: 0 8px;" }, "to"),
              input({
                type: "number",
                placeholder: "Upper bound",
                value: () => state.upperBound,
                oninput: e => state.upperBound = e.target.value,
                disabled: state.submitting,
                step: "any",
                style: "flex: 1; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px;"
              })
            ]),
            div({ 
              style: "font-size: 0.9em; color: var(--text-secondary); margin-top: 4px;" 
            }, "Provide a range you're confident the actual value will fall within")
          ) : null,

        // Confidence slider
        div({ class: "form-group" },
          label({ for: "confidence" }, 
            "Confidence: ", () => span({ class: "confidence-value" }, `${state.confidence}%`)
          ),
          input({
            type: "range", id: "confidence", min: 1, max: 100, step: 1,
            value: () => state.confidence,
            oninput: e => state.confidence = parseInt(e.target.value),
            disabled: state.submitting
          })
        ),

        // Submit button
        Button({
          type: "submit",
          disabled: () => state.submitting || !state.eventId || !state.prediction || !isLoggedInState.val,
          className: "submit-button",
          children: () => state.submitting ? "Submitting..." : "Submit Prediction"
        })
      ])
    ]
  });
}