const MAX_POST_CHARS = 300;

const truncateCodePoints = (input, maxLen) => {
  const chars = Array.from(String(input || ''));
  if (chars.length <= maxLen) return chars.join('');
  return chars.slice(0, maxLen).join('');
};

const normalizeText = (text) => {
  const trimmed = String(text || '').trim();
  if (!trimmed) return ' ';
  return truncateCodePoints(trimmed, MAX_POST_CHARS);
};

const buildPostRecord = ({ text, createdAt }) => {
  return {
    $type: 'app.bsky.feed.post',
    text: normalizeText(text),
    createdAt: new Date(createdAt || Date.now()).toISOString()
  };
};

module.exports = {
  buildPostRecord
};
