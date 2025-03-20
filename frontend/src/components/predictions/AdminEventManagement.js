// src/components/predictions/AdminEventManagement.js
import van from 'vanjs-core';
const { div, h2, h3, h4, p, form, input, textarea, label } = van.tags;
import Card from '../common/Card';
import Button from '../common/Button';
import predictionsStore from '../../store/predictions';  // Direct store import

/**
 * Admin component for managing prediction events
 */
export default function AdminEventManagement() {
  // Form state
  const eventFormState = van.state({
    title: '',
    details: '',
    closingDate: '',
    submitting: false,
    error: '',
    success: ''
  });
  
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
    if (!eventFormState.val.title) {
      eventFormState.val = {...eventFormState.val, error: 'Please enter an event title'};
      return;
    }
    
    if (!eventFormState.val.closingDate) {
      eventFormState.val = {...eventFormState.val, error: 'Please select a closing date'};
      return;
    }
    
    // Submit event
    eventFormState.val = {...eventFormState.val, submitting: true, error: ''};
    
    try {
      await predictionsStore.actions.createEvent.call(predictionsStore,
        eventFormState.val.title,
        eventFormState.val.details,
        eventFormState.val.closingDate
      );
      
      // Reset form on success
      eventFormState.val = {
        title: '',
        details: '',
        closingDate: '',
        submitting: false,
        error: '',
        success: 'Event created successfully!'
      };
      
      // Refresh events
      predictionsStore.actions.fetchEvents.call(predictionsStore);
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        eventFormState.val = {...eventFormState.val, success: ''};
      }, 3000);
    } catch (error) {
      eventFormState.val = {
        ...eventFormState.val, 
        submitting: false, 
        error: error.message || 'Failed to create event'
      };
    }
  };
  
  // Resolve event
  const handleResolveEvent = async (eventId, outcome) => {
    try {
      await predictionsStore.actions.resolveEvent.call(predictionsStore, eventId, outcome);
      predictionsStore.actions.fetchEvents.call(predictionsStore); // Refresh events list
    } catch (error) {
      console.error('Error resolving event:', error);
      // Could show an error toast here
    }
  };
  
  return Card({
    className: "admin-section",
    children: [
      h2("Admin: Event Management"),
      
      // Event creation form
      div({ class: "event-form" }, [
        h3("Create New Event"),
        
        // Error/success message
        () => eventFormState.val.error ? 
          div({ class: "error-message" }, eventFormState.val.error) : null,
        () => eventFormState.val.success ? 
          div({ class: "success-message" }, eventFormState.val.success) : null,
        
        form({ onsubmit: handleSubmit, class: "create-event-form" }, [
          div({ class: "form-group" }, [
            label({ for: "eventTitle" }, "Event Title:"),
            input({
              type: "text",
              id: "eventTitle",
              required: true,
              disabled: eventFormState.val.submitting,
              value: eventFormState.val.title,
              onchange: (e) => eventFormState.val = {...eventFormState.val, title: e.target.value},
              placeholder: "e.g., Will the price of Bitcoin exceed $100,000 by the end of 2025?"
            })
          ]),
          
          div({ class: "form-group" }, [
            label({ for: "eventDetails" }, "Details (Optional):"),
            textarea({
              id: "eventDetails",
              rows: 3,
              disabled: eventFormState.val.submitting,
              value: eventFormState.val.details,
              onchange: (e) => eventFormState.val = {...eventFormState.val, details: e.target.value},
              placeholder: "Add details about the event or criteria for resolution"
            })
          ]),
          
          div({ class: "form-group" }, [
            label({ for: "closingDate" }, "Closing Date:"),
            input({
              type: "date",
              id: "closingDate",
              required: true,
              disabled: eventFormState.val.submitting,
              value: eventFormState.val.closingDate,
              onchange: (e) => eventFormState.val = {...eventFormState.val, closingDate: e.target.value},
              min: new Date().toISOString().split('T')[0] // Today's date as minimum
            })
          ]),
          
          Button({
            type: "submit",
            disabled: eventFormState.val.submitting,
            className: "submit-button"
          }, eventFormState.val.submitting ? "Creating..." : "Create Event")
        ])
      ]),
      
      // Events list for management
      div({ class: "events-management" }, [
        h3("Manage Events"),
        
        () => events.val.length === 0 ? 
          p("No events available. Create one above.") :
          div({ class: "events-list" }, 
            events.val.map(event => 
              div({ class: "event-item" }, [
                h4(event.title),
                p(`Closing: ${new Date(event.closing_date).toLocaleDateString()}`),
                p({ class: "event-details" }, event.details || "No additional details"),
                
                event.outcome ? 
                  p({ class: "event-resolved" }, `Resolved: ${event.outcome}`) :
                  div({ class: "event-actions" }, [
                    // Only show resolve buttons if event isn't resolved
                    Button({
                      onclick: () => handleResolveEvent(event.id, 'yes'),
                      className: "resolve-button yes"
                    }, "Resolve as YES"),
                    Button({
                      onclick: () => handleResolveEvent(event.id, 'no'),
                      className: "resolve-button no"
                    }, "Resolve as NO")
                  ])
              ])
            )
          )
      ])
    ]
  });
}