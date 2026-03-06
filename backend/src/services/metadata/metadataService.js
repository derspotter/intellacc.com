const axios = require('axios');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { assertSsrfSafeUrl } = require('../activitypub/ssrf');
const metascraper = require('metascraper')([
  require('metascraper-author')(),
  require('metascraper-date')(),
  require('metascraper-description')(),
  require('metascraper-image')(),
  require('metascraper-logo')(),
  require('metascraper-publisher')(),
  require('metascraper-title')(),
  require('metascraper-url')()
]);

/**
 * Extracts the first http/https URL from a string.
 */
const extractFirstUrl = (text) => {
  if (!text) return null;
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const match = text.match(urlRegex);
  return match ? match[0] : null;
};

const MAX_REDIRECTS = 5;
const REQUEST_OPTIONS = {
  timeout: 8000,
  headers: {
    'User-Agent': 'IntellaccBot/1.0 (+https://intellacc.com)'
  },
  maxContentLength: 5 * 1024 * 1024,
  maxRedirects: 0,
  responseType: 'text',
  validateStatus: (status) => status >= 200 && status < 400
};

const fetchPublicHttpText = async (url) => {
  let currentUrl = (await assertSsrfSafeUrl(url)).toString();

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await axios.get(currentUrl, REQUEST_OPTIONS);

    if (response.status >= 300 && response.status < 400) {
      const location = String(response.headers?.location || '').trim();
      if (!location) {
        throw new Error('Redirect missing location header');
      }

      if (redirects === MAX_REDIRECTS) {
        throw new Error('Too many redirects');
      }

      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = (await assertSsrfSafeUrl(nextUrl)).toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Unexpected response status: ${response.status}`);
    }

    return {
      html: response.data,
      finalUrl: currentUrl
    };
  }

  throw new Error('Failed to fetch URL');
};

/**
 * Fetches OpenGraph/Meta tags for a given URL.
 */
const fetchMetadata = async (url) => {
  try {
    const { html, finalUrl } = await fetchPublicHttpText(url);
    
    // 1. Extract metadata (Fair Use)
    const metadata = await metascraper({ html, url: finalUrl });

    return {
      url: finalUrl,
      title: metadata.title || null,
      description: metadata.description || null,
      image_url: metadata.image || null,
      site_name: metadata.publisher || null,
      content: null // Removed full text scraping for copyright compliance
    };
  } catch (error) {
    console.warn(`Failed to fetch metadata for ${url}:`, error.message);
    return null;
  }
};

/**
 * Fetches full article content EPHEMERALLY for AI processing only.
 * This content MUST NOT be stored in the database.
 */
const fetchArticleContent = async (url) => {
  try {
    const { html, finalUrl } = await fetchPublicHttpText(url);
    const doc = new JSDOM(html, { url: finalUrl });
    const reader = new Readability(doc.window.document);
    const article = reader.parse();
    
    if (article && article.textContent) {
      return article.textContent.replace(/\n\s*\n/g, '\n\n').trim();
    }
    return null;
  } catch (error) {
    console.warn(`Failed to fetch ephemeral article content for ${url}:`, error.message);
    return null;
  }
};

module.exports = {
  extractFirstUrl,
  fetchMetadata,
  fetchArticleContent
};
