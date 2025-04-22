import van from 'vanjs-core';
const { div, form, select, option, label, input, span } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import predictionsStore from '../../store/predictions';

/**
 * Form for creating new predictions
 */
export default function CreatePredictionForm() {
  const formState = van.state({
    eventId: '', prediction: '', confidence: 50,
    submitting: false, error: '', success: ''
  });
  const events = predictionsStore.state.events;
  
  if (events.val.length === 0) {
    setTimeout(() => predictionsStore.actions.fetchEvents.call(predictionsStore), 0);
  }
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formState.val.eventId || !formState.val.prediction) { 
      formState.val.error = !formState.val.eventId ? 'Please select an event' : 'Please select your prediction';
      return;
    }
    
    formState.val.submitting = true;
    formState.val.error = '';
    
    try {
      await predictionsStore.actions.createPrediction.call(
        predictionsStore,
        formState.val.eventId,
        formState.val.prediction,
        formState.val.confidence
      );
      
      formState.val = {...formState.val, eventId: '', prediction: '', confidence: 50, 
                        submitting: false, success: 'Prediction created successfully!'};
      setTimeout(() => formState.val.success = '', 3000);
    } catch (e) {
      formState.val.submitting = false;
      formState.val.error = e.message || 'Failed to create prediction';
    }
  };
  
  return Card({
    className: "prediction-form",
    children: [
      () => formState.val.error ? div({ class: "error-message" }, formState.val.error) : null,
      () => formState.val.success ? div({ class: "success-message" }, formState.val.success) : null,
      
      form({ onsubmit: handleSubmit }, [
        div({ class: "form-group" }, [
          label({ for: "eventId" }, "Select Event:"),
          events.val.length === 0 
            ? div({ class: "loading-events" }, [
                span("Loading events..."),
                Button({ onclick: () => predictionsStore.actions.fetchEvents.call(predictionsStore),
                       className: "refresh-button small" }, "↻")
              ])
            : select({
                id: "eventId", required: true, disabled: formState.val.submitting,
                value: () => formState.val.eventId, onchange: e => formState.val.eventId = e.target.value
              }, [
                option({ value: "" }, "-- Select an event --"),
                ...events.val.map(event => option({ value: event.id }, event.title))
              ])
        ]),
        
        div({ class: "form-group" }, [
          label({ for: "prediction" }, "Your Prediction:"),
          select({
            id: "prediction", required: true, disabled: formState.val.submitting,
            value: () => formState.val.prediction, onchange: e => formState.val.prediction = e.target.value
          }, [
            option({ value: "" }, "-- Select your prediction --"),
            option({ value: "Yes" }, "Yes"), option({ value: "No" }, "No")
          ])
        ]),
        
        div({ class: "form-group" }, [
          label({ for: "confidence" }, ["Confidence: ", 
            span({ class: "confidence-value" }, () => `${formState.val.confidence}%`)]),
          input({
            type: "range", id: "confidence", min: "1", max: "100", step: "1",
            disabled: formState.val.submitting, value: () => formState.val.confidence,
            oninput: e => formState.val.confidence = parseInt(e.target.value)
          })
        ]),
        
        Button({
          type: "submit", disabled: formState.val.submitting, className: "submit-button"
        }, () => formState.val.submitting ? "Submitting..." : "Submit Prediction")
      ])
    ]
  });
}