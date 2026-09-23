const { extractFirstUrl, fetchArticleContent } = require('../metadata/metadataService');
const { PROMPT_LIMITS, clip } = require('./prompts');

// Only the selected, visibility-checked post is fetched. No crawling, cookies,
// provider credentials or model-generated URLs. Extracted text stays ephemeral.
const loadArticleContext = async (post) => {
  const url = extractFirstUrl(post?.content);
  if (!url) return null;
  let text;
  try { text = await fetchArticleContent(url); } catch { /* Continue with explicit missing context. */ }
  return { url: clip(url, 1000), text: text?.trim().length > 50 ? clip(text.trim(), PROMPT_LIMITS.articleChars) : null };
};

module.exports = { loadArticleContext };
