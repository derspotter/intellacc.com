import van from 'vanjs-core';
const { div, span } = van.tags;
import Card from '../common/Card';

/**
 * Single prediction component
 */
export default function PredictionItem({ prediction }) {
  // Determine outcome status class
  const getStatusClass = () => {
    if (!prediction.outcome) return "pending";
    return prediction.outcome === "correct" ? "correct" : "incorrect";
  };
  
  return Card({
    className: `prediction-item ${getStatusClass()}`,
    children: [
      div({ class: "prediction-header" }, [
        span({ class: "prediction-event" }, prediction.event),
        span({ 
          class: `prediction-status ${getStatusClass()}` 
        }, prediction.outcome ? 
          prediction.outcome.charAt(0).toUpperCase() + prediction.outcome.slice(1) : 
          "Pending"
        )
      ]),
      div({ class: "prediction-details" }, [
        div({ class: "prediction-value" }, [
          span({ class: "label" }, "Prediction:"),
          span({ class: "value" }, prediction.prediction_value)
        ]),
        div({ class: "prediction-confidence" }, [
          span({ class: "label" }, "Confidence:"),
          span({ class: "value" }, `${prediction.confidence}%`)
        ]),
        div({ class: "prediction-date" }, [
          span({ class: "label" }, "Created:"),
          span({ class: "value" }, new Date(prediction.created_at).toLocaleDateString())
        ])
      ])
    ]
  });
}