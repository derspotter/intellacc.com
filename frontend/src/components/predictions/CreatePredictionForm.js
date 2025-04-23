// frontend/src/components/predictions/CreatePredictionForm.js
import van from 'vanjs-core';
const { div, form, select, option, label, input, span, button } = van.tags;
const { derive } = van; // Add derive for reactive option list
import Button from '../common/Button'; // Assuming this is a VanJS component or returns a DOM element
import Card from '../common/Card';   // Assuming this is a VanJS component or returns a DOM element
import predictionsStore from '../../store/predictions';
import { isLoggedInState } from '../../services/auth';

/**
 * Form for creating new predictions - Refactored for idiomatic VanJS
 */
export default function CreatePredictionForm() {
  // --- States ---
  const eventId = van.state('');
  const prediction = van.state('');
  const confidence = van.state(50);
  const submitting = van.state(false);
  const error = van.state('');
  const success = van.state('');
  const displayMode = van.state('voluntary'); // 'voluntary' or 'assigned'

  // --- Store State References ---
  // Direct references to the states in the store for reactivity
  const events = predictionsStore.state.events;
  const assignedPredictions = predictionsStore.state.assignedPredictions;
  const isLoadingEvents = predictionsStore.state.loadingEvents;
  const isLoadingAssigned = predictionsStore.state.loadingAssigned;

  // --- Derived Event Options ---
  const eventOptions = derive(() => {
    const opts = [ option({ value: '', selected: () => eventId.val === '' }, '-- Select --') ];
    if (!isLoggedInState.val) {
      opts.push(option({ value: '', disabled: true }, 'Please log in'));
      return opts;
    }
    if (displayMode.val === 'voluntary') {
      if (isLoadingEvents.val) {
        opts.push(option({ value: '', disabled: true }, 'Loading events...'));
      } else if (events.val.length === 0) {
        opts.push(option({ value: '', disabled: true }, 'No open voluntary events'));
      } else {
        events.val.forEach(ev => {
          opts.push(option({ value: String(ev.id), selected: () => eventId.val === String(ev.id) }, ev.title));
        });
      }
    } else {
      if (isLoadingAssigned.val) {
        opts.push(option({ value: '', disabled: true }, 'Loading assignments...'));
      } else if (assignedPredictions.val.length === 0) {
        opts.push(option({ value: '', disabled: true }, 'No pending assignments'));
      } else {
        assignedPredictions.val.forEach(asg => {
          opts.push(option({ value: String(asg.event_id), selected: () => eventId.val === String(asg.event_id) }, asg.event || `Assignment ${asg.id}`));
        });
      }
    }
    return opts;
  });

  // --- Event Handlers ---
  const handleSubmit = async (e) => {
    e.preventDefault();
    // Basic validation
    if (!eventId.val) { error.val = 'Please select an event or assignment'; return; }
    if (!prediction.val) { error.val = 'Please select your prediction'; return; }

    submitting.val = true; error.val = ''; success.val = ''; // Reset feedback states

    try {
      await predictionsStore.actions.createPrediction.call(predictionsStore, eventId.val, prediction.val, confidence.val);
      // Reset form fields on success
      eventId.val = ''; prediction.val = ''; confidence.val = 50;
      success.val = 'Prediction created successfully!';
      setTimeout(() => { success.val = ''; }, 3000); // Clear success message
    } catch (err) {
      error.val = err.message || 'Failed to create prediction';
    } finally {
      submitting.val = false; // Ensure submitting is reset
    }
  };

  const handleToggleClick = (newMode) => {
    if (displayMode.val !== newMode) {
      displayMode.val = newMode;
      eventId.val = ''; // Reset event selection when mode changes
      // Data fetching is handled by the router, no need to fetch here
    }
  };

  // --- UI Construction ---
  // Build the DOM structure using van.tags and reactive bindings

  return Card({
    title: "Make a New Prediction",
    className: "prediction-form",
    children: [
      // Toggle Buttons - Using reactive functions for class
      div({ class: 'prediction-toggle-container' },
        button({
          class: () => `toggle-button ${displayMode.val === 'voluntary' ? 'active' : ''}`,
          onclick: () => handleToggleClick('voluntary')
        }, "Voluntary"),
        button({
          class: () => `toggle-button ${displayMode.val === 'assigned' ? 'active' : ''}`,
          onclick: () => handleToggleClick('assigned')
        }, "Assigned")
      ),

      // Feedback Messages - Using reactive functions for conditional rendering
      () => error.val ? div({ class: "error-message" }, error.val) : null,
      () => success.val ? div({ class: "success-message" }, success.val) : null,

      // Main Form
      form({ onsubmit: handleSubmit }, [
        // Event/Assignment Dropdown
        div({ class: 'form-group' },
          label({ for: 'event' }, 
            () => `Select ${displayMode.val === 'voluntary' ? 'Event' : 'Assignment'}:`
          ),
          
          // Simple functional child approach with vanilla DOM properties
          () => {
            // Create the select element
            const sel = select({
              id: 'event',
              required: true, 
              oninput: e => eventId.val = e.target.value,
              disabled: submitting.val || !isLoggedInState.val
            });
            
            // Default option
            sel.appendChild(option({ value: '' }, '-- Select --'));
            
            // Add dynamic options based on mode
            const list = displayMode.val === 'voluntary' ? events.val : assignedPredictions.val;
            for (const item of list) {
              const val = String(displayMode.val === 'voluntary' ? item.id : item.event_id);
              const text = displayMode.val === 'voluntary' ? item.title : (item.event || `Assignment ${item.id}`);
              sel.appendChild(option({ value: val }, text));
            }
            
            // Manually set the value (this is key!)
            setTimeout(() => { 
              if (sel && sel.value !== eventId.val) sel.value = eventId.val;
            }, 0);
            
            return sel;
          }
        ),
        // Prediction Dropdown - Apply similar fixes
        div({ class: "form-group" },
          label({ for: "prediction" }, "Your Prediction:"),
          select({
            id: "prediction",
            required: true,
            value: () => prediction.val,
            disabled: () => submitting.val,
            oninput: e => { prediction.val = e.target.value; }
          }, [
            // Static options can be directly in an array
            option({ value: "" }, "-- Select your prediction --"),
            option({ value: "Yes" }, "Yes"),
            option({ value: "No" }, "No")
          ])
        ),

        // Confidence Slider
        div({ class: "form-group" },
          label({ for: "confidence" },
            "Confidence: ",
            // Reactive span showing current confidence value
            () => span({ class: "confidence-value" }, `${confidence.val}%`)
          ),
          input({
            type: "range", id: "confidence", min: 1, max: 100, step: 1,
            value: () => confidence.val, 
            disabled: () => submitting.val,
            oninput: e => confidence.val = parseInt(e.target.value)
          })
        ),

        // Submit Button
        // Assuming Button component handles reactive children/props correctly
        Button({
          type: "submit",
          disabled: () => submitting.val || !eventId.val || !prediction.val || !isLoggedInState.val,
          className: "submit-button",
          children: () => submitting.val ? "Submitting..." : "Submit Prediction"
        })
      ]) // End form
    ] // End Card children
  }); // End Card
} // End component