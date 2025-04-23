// frontend/src/components/predictions/CreatePredictionForm.js
import van from 'vanjs-core';
import * as vanX from 'vanjs-ext';
const { div, form, select, option, label, input, span, button } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import predictionsStore from '../../store/predictions';
import { isLoggedInState } from '../../services/auth';

/**
 * Form for creating new predictions - Ultra concise VanX implementation
 */
export default function CreatePredictionForm() {
  // --- Combined state ---
  const state = vanX.reactive({
    eventId: '',
    prediction: '',
    confidence: 50,
    submitting: false,
    error: '',
    success: '',
    displayMode: 'voluntary'
  });
  
  // --- Store References ---
  const { events, assignedPredictions, loadingEvents, loadingAssigned, predictions } = predictionsStore.state;

  // --- Form submission ---
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!state.eventId || !state.prediction) {
      state.error = !state.eventId ? 'Please select an event' : 'Please select your prediction';
      return;
    }

    state.submitting = true;
    state.error = '';
    
    try {
      await predictionsStore.actions.createPrediction.call(
        predictionsStore, state.eventId, state.prediction, state.confidence
      );
      state.eventId = state.prediction = '';
      state.confidence = 50;
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
            onclick: () => { state.displayMode = mode; state.eventId = ''; }
          }, mode.charAt(0).toUpperCase() + mode.slice(1))
        )
      ),

      // Feedback messages
      () => state.error && div({ class: "error-message" }, state.error),
      () => state.success && div({ class: "success-message" }, state.success),

      // Form
      form({ onsubmit: handleSubmit }, [
        // Event dropdown with reactive display
        div({ class: "form-group" },
          label({ for: "event" }, () => `Select ${state.displayMode === 'voluntary' ? 'Event' : 'Assignment'}:`),
          
          // Dropdown with reactive options - this pattern now works reliably
          () => {
            const userPredictionEventIds = new Set(predictions.val.map(p => p.event_id));
            const availableEvents = events.val.filter(event => !userPredictionEventIds.has(event.id));
            
            const dataList = state.displayMode === 'voluntary' ? availableEvents : assignedPredictions.val;
            const loading = state.displayMode === 'voluntary' ? loadingEvents.val : loadingAssigned.val;
            
            return select({
              id: "event",
              required: true,
              onchange: e => state.eventId = e.target.value,
              disabled: state.submitting || !isLoggedInState.val
            }, [
              option({ value: '' }, "-- Select --"),
              
              // Status option
              !isLoggedInState.val ? option({ value: '', disabled: true }, "Please log in") :
              loading ? option({ value: '', disabled: true }, "Loading...") :
              dataList.length === 0 ? option(
                { value: '', disabled: true },
                state.displayMode === 'voluntary' ? 
                  (events.val.length > 0 ? 'No more events to predict' : 'No open events') : 
                  'No pending assignments'
              ) : null,
              
              // Map data to options
              ...(dataList.map(item => option({
                value: String(state.displayMode === 'voluntary' ? item.id : item.event_id),
                selected: () => state.eventId === String(state.displayMode === 'voluntary' ? item.id : item.event_id)
              }, state.displayMode === 'voluntary' ? item.title : (item.event || `Assignment ${item.id}`))))
            ]);
          }
        ),

        // Prediction dropdown
        div({ class: "form-group" },
          label({ for: "prediction" }, "Your Prediction:"),
          select({
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
          ])
        ),

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