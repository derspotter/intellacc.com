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
    displayMode: 'voluntary',
    searchTerm: '',
    showDropdown: false
  });
  
  // --- Store References ---
  const { events, assignedPredictions, loadingEvents, loadingAssigned, predictions } = predictionsStore.state;

  // --- Search handlers ---
  const handleSearch = async (searchTerm) => {
    state.searchTerm = searchTerm;
    state.eventId = ''; // Clear selection when searching
    if (state.displayMode === 'voluntary') {
      await predictionsStore.actions.fetchEvents.call(predictionsStore, searchTerm);
    }
  };

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
      state.searchTerm = '';
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
            placeholder: "Search questions by keyword...",
            value: () => state.searchTerm,
            oninput: e => handleSearch(e.target.value),
            disabled: state.submitting || !isLoggedInState.val
          }) : null,
          
          // Event selection dropdown - reactive based on search results
          () => {
            if (state.displayMode === 'voluntary') {
              const userPredictionEventIds = new Set(predictions.val.map(p => p.event_id));
              const availableEvents = events.val.filter(event => !userPredictionEventIds.has(event.id));
              
              return select({
                id: "event",
                required: true,
                onchange: e => state.eventId = e.target.value,
                disabled: state.submitting || !isLoggedInState.val,
                style: "margin-top: 8px;"
              }, [
                option({ value: '' }, "-- Select Event --"),
                
                // Status options
                !isLoggedInState.val ? option({ value: '', disabled: true }, "Please log in") :
                loadingEvents.val ? option({ value: '', disabled: true }, "Searching...") :
                availableEvents.length === 0 ? option(
                  { value: '', disabled: true },
                  state.searchTerm ? 'No events found for your search' : 'No events available'
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