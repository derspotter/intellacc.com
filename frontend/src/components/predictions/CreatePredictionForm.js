import van from 'vanjs-core';
const { div, form, select, option, label, input, span } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import predictionsStore from '../../store/predictions';  // Direct store import

/**
 * Form for creating new predictions
 */
export default function CreatePredictionForm() {
  // Use separate state for each field - this prevents the entire form from re-rendering
  // when just one field changes
  const eventId = van.state('');
  const prediction = van.state('');
  const confidence = van.state(50);
  const submitting = van.state(false);
  const error = van.state('');
  const success = van.state('');
  
  // Get store state directly
  const events = predictionsStore.state.events;
  
  // Fetch events if needed
  if (events.val.length === 0) {
    setTimeout(() => predictionsStore.actions.fetchEvents.call(predictionsStore), 0);
  }
  
  // Form submission handler
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validate form
    if (!eventId.val) {
      error.val = 'Please select an event';
      return;
    }
    
    if (!prediction.val) {
      error.val = 'Please select your prediction';
      return;
    }
    
    // Submit prediction
    submitting.val = true;
    error.val = '';
    
    try {
      await predictionsStore.actions.createPrediction.call(predictionsStore,
        eventId.val,
        prediction.val,
        confidence.val
      );
      
      // Reset form on success
      eventId.val = '';
      prediction.val = '';
      confidence.val = 50;
      submitting.val = false;
      success.val = 'Prediction created successfully!';
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        success.val = '';
      }, 3000);
    } catch (e) {
      submitting.val = false;
      error.val = e.message || 'Failed to create prediction';
    }
  };
  
  // Create event options dynamically
  const EventOptions = () => [
    option({ value: "" }, "-- Select an event --"),
    ...events.val.map(event => 
      option({ value: event.id }, event.title)
    )
  ];
  
  return Card({
    title: "Make a New Prediction",
    className: "prediction-form",
    children: [
      // Error/success message
      () => error.val ? 
        div({ class: "error-message" }, error.val) : null,
      () => success.val ? 
        div({ class: "success-message" }, success.val) : null,
      
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
              disabled: submitting.val,
              onchange: e => { eventId.val = e.target.value; }
            }, EventOptions())
        ]),
        
        // Prediction dropdown
        div({ class: "form-group" }, [
          label({ for: "prediction" }, "Your Prediction:"),
          select({
            id: "prediction",
            required: true,
            disabled: submitting.val,
            onchange: e => { prediction.val = e.target.value; }
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
            () => span({ class: "confidence-value" }, `${confidence.val}%`)
          ]),
          input({
            type: "range",
            id: "confidence",
            min: 1,
            max: 100,
            step: 1,
            disabled: submitting.val,
            value: confidence,
            oninput: e => confidence.val = parseInt(e.target.value)
          })
        ]),
        
        // Submit button
        Button({
          type: "submit",
          disabled: submitting.val,
          className: "submit-button"
        }, () => submitting.val ? "Submitting..." : "Submit Prediction")
      ])
    ]
  });
}