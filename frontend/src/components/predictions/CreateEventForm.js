import van from 'vanjs-core';
const { div, form, label, input, textarea, span } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import predictionsStore from '../../store/predictions';

/**
 * Form for creating new events that users can predict on
 */
export default function CreateEventForm() {
  const title = van.state('');
  const details = van.state('');
  const closingDate = van.state('');
  const submitting = van.state(false);
  const error = van.state('');
  const success = van.state('');
  
  // Get minimum date (tomorrow)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minDate = tomorrow.toISOString().split('T')[0];
  
  // Form submission handler
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validate form
    if (!title.val.trim()) {
      error.val = 'Please enter an event title';
      return;
    }
    
    if (!closingDate.val) {
      error.val = 'Please select a closing date';
      return;
    }
    
    // Validate closing date is in the future
    const selectedDate = new Date(closingDate.val);
    if (selectedDate <= new Date()) {
      error.val = 'Closing date must be in the future';
      return;
    }
    
    // Submit event
    submitting.val = true;
    error.val = '';
    
    try {
      await predictionsStore.actions.createEvent.call(predictionsStore,
        title.val.trim(),
        details.val.trim(),
        closingDate.val
      );
      
      // Reset form on success
      title.val = '';
      details.val = '';
      closingDate.val = '';
      submitting.val = false;
      error.val = '';
      success.val = 'Event created successfully! Users can now make predictions on it.';
      
      // Clear success message after 5 seconds
      setTimeout(() => {
        success.val = '';
      }, 5000);
    } catch (e) {
      submitting.val = false;
      error.val = e.message || 'Failed to create event';
    }
  };
  
  return Card({
    title: "Create New Event",
    className: "event-creation-form",
    children: [
      // Error/success message
      () => error.val ? 
        div({ class: "error-message" }, error.val) : null,
      () => success.val ? 
        div({ class: "success-message" }, success.val) : null,
      
      // Event creation form
      form({ onsubmit: handleSubmit }, [
        // Event title
        div({ class: "form-group" }, [
          label({ for: "event-title" }, "Event Title:"),
          input({
            type: "text",
            id: "event-title",
            placeholder: "e.g., Will Bitcoin exceed $100,000 by end of 2025?",
            required: true,
            disabled: submitting,
            value: title,
            maxlength: "255",
            oninput: (e) => {
              title.val = e.target.value;
            }
          }),
          span({ class: "field-help" }, "Be specific and clear about what you're asking")
        ]),
        
        // Event details
        div({ class: "form-group" }, [
          label({ for: "event-details" }, "Details (Optional):"),
          textarea({
            id: "event-details",
            placeholder: "Additional context, sources, or criteria for the event...",
            disabled: submitting,
            value: details,
            rows: "4",
            oninput: (e) => {
              details.val = e.target.value;
            }
          }),
          span({ class: "field-help" }, "Provide context to help users make informed predictions")
        ]),
        
        // Closing date
        div({ class: "form-group" }, [
          label({ for: "closing-date" }, "Closing Date:"),
          input({
            type: "date",
            id: "closing-date",
            required: true,
            disabled: submitting,
            value: closingDate,
            min: minDate,
            onchange: (e) => {
              closingDate.val = e.target.value;
            }
          }),
          span({ class: "field-help" }, "When should predictions close? Must be in the future.")
        ]),
        
        // Submit button
        Button({
          type: "submit",
          disabled: submitting,
          className: "submit-button",
          children: () => submitting.val ? "Creating Event..." : "Create Event"
        })
      ])
    ]
  });
}