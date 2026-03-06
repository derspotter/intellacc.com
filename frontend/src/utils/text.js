export function renderTextWithLinks(text, van) {
  if (!text) return text;
  
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  
  return parts.map((part) => {
    if (part.match(urlRegex)) {
      return van.tags.a({ 
        href: part, 
        target: '_blank', 
        rel: 'noopener noreferrer',
        style: 'color: var(--accent-color, #007bff); text-decoration: underline;'
      }, part);
    }
    return part;
  });
}