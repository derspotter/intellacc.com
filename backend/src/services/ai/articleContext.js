const { extractFirstUrl, fetchArticleContent } = require('../metadata/metadataService');
const { PROMPT_LIMITS, clip } = require('./prompts');

// Only the selected, visibility-checked post is fetched. No crawling, cookies,
// provider credentials or model-generated URLs. Extracted text stays ephemeral.
const loadArticleContext = async (post) => {
  const url = extractFirstUrl(post?.content);
  if (!url) return null;
  let text;
  try { text = await fetchArticleContent(url); } catch { /* Continue with explicit missing context. */ }
  const extracted = typeof text === 'string' ? text.trim() : '';
  return {
    url: clip(url, 1000),
    text: extracted.length > 50 ? clip(extracted, PROMPT_LIMITS.articleChars) : null,
    truncated: extracted.length > PROMPT_LIMITS.articleChars
  };
};

module.exports = { loadArticleContext };
