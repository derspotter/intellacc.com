import van from 'vanjs-core';
const { div, form, select, option, label, input, span } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import predictionsStore from '../../store/predictions';

/**
 * Form for creating new predictions
 */
export default function CreatePredictionForm() {
  // Use a single form state object to reduce re-renders
  const formState = van.state({
    eventId: '',
    prediction: '',
    confidence: 50,
    submitting: false,
    error: '',
    success: ''
  });
  
  // Get store state directly
  const events = predictionsStore.state.events;
  
  // Fetch events only once on component mount
  van.derive(() => {
    if (events.val.length === 0) {
      predictionsStore.actions.fetchEvents.call(predictionsStore);
    }
  });
  
  // Form submission handler
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validate form
    if (!formState.val.eventId) {
      formState.val = {...formState.val, error: 'Please select an event'};
      return;
    }
    
    if (!formState.val.prediction) {
      formState.val = {...formState.val, error: 'Please select your prediction'};
      return;
    }
    
    // Submit prediction
    formState.val = {...formState.val, submitting: true, error: ''};
    
    try {
      await predictionsStore.actions.createPrediction.call(predictionsStore,
        formState.val.eventId,
        formState.val.prediction,
        formState.val.confidence
      );
      
      // Reset form on success
      formState.val = {
        eventId: '',
        prediction: '',
        confidence: 50,
        submitting: false,
        error: '',
        success: 'Prediction created successfully!'
      };
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        formState.val = {...formState.val, success: ''};
      }, 3000);
    } catch (e) {
      formState.val = {
        ...formState.val, 
        submitting: false, 
        error: e.message || 'Failed to create prediction'
      };
    }
  };
  
  return Card({
    title: "Make a New Prediction",
    className: "prediction-form",
    children: [
      // Error/success message
      () => formState.val.error ? 
        div({ class: "error-message" }, formState.val.error) : null,
      () => formState.val.success ? 
        div({ class: "success-message" }, formState.val.success) : null,
      
      // Prediction form
      form({ onsubmit: handleSubmit }, [
        // Events dropdown
        div({ class: "form-group" }, [
          label({ for: "event" }, "Select Event:"),
          () => events.val.length === 0 ?
            div({ class: "loading-events" }, [
              span("Loading events..."),
              Button({ 
                onclick: () => predictionsStore.actions.fetchEvents.call(predictionsStore),
                className: "refresh-button small" 
              }, "↻")
            ]) :
            select({
              id: "event",
              required: true,
              disabled: formState.val.submitting,
              value: formState.val.eventId,
              onchange: (e) => {
                // Create a new state object to trigger a single update
                formState.val = {...formState.val, eventId: e.target.value};
              }
            }, [
              option({ value: "" }, "-- Select an event --"),
              ...events.val.map(event => 
                option({ value: event.id }, event.title)
              )
            ])
        ]),
        
        // Prediction dropdown
        div({ class: "form-group" }, [
          label({ for: "prediction" }, "Your Prediction:"),
          select({
            id: "prediction",
            required: true,
            disabled: formState.val.submitting,
            value: formState.val.prediction,
            onchange: (e) => {
              formState.val = {...formState.val, prediction: e.target.value};
            }
          }, [
            option({ value: "" }, "-- Select your prediction --"),
            option({ value: "Yes" }, "Yes"),
            option({ value: "No" }, "No")
          ])
        ]),
        
        // Confidence slider
        div({ class: "form-group" }, [
          label({ for: "confidence" }, [
            "Confidence: ",
            span({ class: "confidence-value" }, `${formState.val.confidence}%`)
          ]),
          input({
            type: "range",
            id: "confidence",
            min: "1",
            max: "100",
            step: "1",
            disabled: formState.val.submitting,
            value: formState.val.confidence,
            onchange: (e) => {
              formState.val = {
                ...formState.val, 
                confidence: parseInt(e.target.value)
              };
            }
          })
        ]),
        
        // Submit button
        Button({
          type: "submit",
          disabled: formState.val.submitting,
          className: "submit-button"
        }, formState.val.submitting ? "Submitting..." : "Submit Prediction")
      ])
    ]
  });
}