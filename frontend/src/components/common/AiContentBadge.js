/**
 * AI Content Badge
 * Shows an indicator for likely AI-generated content
 */
import van from 'vanjs-core';

const { span } = van.tags;

export default function AiContentBadge({ aiProbability, aiFlagged, detectedModel } = {}) {
  const probability = Number(aiProbability);
  const flagged = aiFlagged === true || (!Number.isNaN(probability) && probability >= 0.85);

  if (!flagged) {
    return null;
  }

  const percent = Number.isNaN(probability) ? null : Math.round(probability * 100);
  const label = percent ? `AI ${percent}%` : 'AI suspected';
  const title = detectedModel
    ? `Likely AI-generated (${detectedModel})`
    : 'Likely AI-generated content';

  return span({ class: 'ai-content-badge', title }, label);
}
