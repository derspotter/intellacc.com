import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const markdown = new Marked({ gfm: true, breaks: true });
export const renderMarkdown = (content) => {
  // Provider output is untrusted. Keep formatting, never executable HTML,
  // remote images, embeds, forms, styles or model-supplied element IDs.
  const fragment = DOMPurify.sanitize(markdown.parse(String(content || '')), {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code',
      'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true
  });
  for (const link of fragment.querySelectorAll('a[href]')) {
    try {
      const url = new URL(link.getAttribute('href'), window.location.href);
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) {
        link.removeAttribute('href');
      } else if (url.origin !== window.location.origin) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
    } catch { link.removeAttribute('href'); }
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
};

