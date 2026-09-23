const axios = require('axios');

// This is a private service URL from deployment config, never a user URL.
const fetchBrowserArticle = async (url, signal) => {
  const endpoint = process.env.ARTICLE_BROWSER_URL;
  if (!endpoint || signal.aborted) return null;
  const response = await axios.post(`${endpoint}/read`, { url }, {
    signal, timeout: 21000, maxRedirects: 0, maxContentLength: 512 * 1024,
    headers: { 'Content-Type': 'application/json' }
  });
  const text = response.data?.text;
  return typeof text === 'string' && text.trim().length >= 100 ? text.trim().slice(0, 100000) : null;
};
module.exports = { fetchBrowserArticle };
