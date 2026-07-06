export const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const formatProbability = (value) => `${(safeNumber(value, 0.5) * 100).toFixed(1)}%`;
export const formatCurrency = (value, { includeSymbol = true } = {}) => {
  const formatted = safeNumber(value).toFixed(2);
  return includeSymbol ? `${formatted} RP` : formatted;
};

export const toDate = (value) => {
  const parsed = new Date(value || '');
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

export const toShortDate = (value) => {
  const parsed = toDate(value);
  if (!parsed) {
    return 'No date';
  }
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

export const isPhoneVerificationMessage = (message) =>
  typeof message === 'string' && message.toLowerCase().includes('verify your phone');

export const getProbabilityColor = (probability) => {
  const prob = safeNumber(probability, 0.5);
  const red = Math.round(prob * 255);
  const blue = Math.round((1 - prob) * 255);
  return `rgb(${red}, 0, ${blue})`;
};

export const getKellyEdge = (belief, currentProb) =>
  (safeNumber(belief, 0.5) - safeNumber(currentProb, 0.5));
