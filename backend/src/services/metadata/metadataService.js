const axios = require('axios');
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
const TOTAL_TIMEOUT_MS = 10000;
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

let readabilityDeps = null;

const getReadabilityDeps = () => {
  if (!readabilityDeps) {
    const { JSDOM } = require('jsdom');
    const { Readability } = require('@mozilla/readability');
    readabilityDeps = { JSDOM, Readability };
  }
  return readabilityDeps;
};

// DNS checks, every redirect, the response body and extraction share one
// deadline. Axios cancellation stops an outstanding HTTP request at expiry.
const abortable = (promise, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason || new Error('Metadata deadline exceeded'));
  Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  if (signal.aborted) { abort(); return; }
  signal.addEventListener('abort', abort, { once: true });
});

const withDeadline = async (operation, { timeoutMs = TOTAL_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Metadata deadline exceeded')), timeoutMs);
  try { return await abortable(operation(controller.signal), controller.signal); }
  finally { clearTimeout(timer); }
};

const fetchPublicHttpText = async (url, signal) => {
  let currentUrl = (await abortable(assertSsrfSafeUrl(url), signal)).toString();

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await axios.get(currentUrl, { ...REQUEST_OPTIONS, signal });

    if (response.status >= 300 && response.status < 400) {
      const location = String(response.headers?.location || '').trim();
      if (!location) {
        throw new Error('Redirect missing location header');
      }

      if (redirects === MAX_REDIRECTS) {
        throw new Error('Too many redirects');
      }

      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = (await abortable(assertSsrfSafeUrl(nextUrl), signal)).toString();
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
const fetchMetadata = async (url, options) => {
  try {
    return await withDeadline(async (signal) => {
      const { html, finalUrl } = await fetchPublicHttpText(url, signal);

      // 1. Extract metadata (Fair Use)
      const metadata = await abortable(metascraper({ html, url: finalUrl }), signal);

      return {
        url: finalUrl,
        title: metadata.title || null,
        description: metadata.description || null,
        image_url: metadata.image || null,
        site_name: metadata.publisher || null,
        content: null // Removed full text scraping for copyright compliance
      };
    }, options);
  } catch (error) {
    if (options?.throwOnError) throw error;
    console.warn(`Failed to fetch metadata for ${url}:`, error.message);
    return null;
  }
};

/**
 * Fetches full article content EPHEMERALLY for AI processing only.
 * This content MUST NOT be stored in the database.
 */
const fetchArticleContent = async (url, options) => {
  try {
    return await withDeadline(async (signal) => {
      const { html, finalUrl } = await fetchPublicHttpText(url, signal);
      const { JSDOM, Readability } = getReadabilityDeps();
      const doc = new JSDOM(html, { url: finalUrl });
      const reader = new Readability(doc.window.document);
      const article = reader.parse();

      if (article && article.textContent) {
        return article.textContent.replace(/\n\s*\n/g, '\n\n').trim();
      }
      return null;
    }, options);
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
