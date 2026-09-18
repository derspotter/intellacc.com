export function safeWebUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// Keep sentence/Markdown delimiters out of links, retaining balanced URL parentheses.
export function textLinkParts(text = '') {
  const parts = [];
  const pattern = /https?:\/\/[^\s<>"'\[\]]+/gi;
  let cursor = 0;
  for (const match of String(text).matchAll(pattern)) {
    let raw = match[0].replace(/[.,!?;:]+$/, '');
    while (raw.endsWith(')') && (raw.match(/\)/g) || []).length > (raw.match(/\(/g) || []).length) raw = raw.slice(0, -1);
    const url = safeWebUrl(raw.replace(/&amp;/g, '&'));
    if (!url) continue;
    parts.push({ text: text.slice(cursor, match.index) }, { text: raw, url });
    cursor = match.index + raw.length;
  }
  parts.push({ text: text.slice(cursor) });
  return parts;
}

const startSeconds = (value) => {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value || '');
  return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0;
};

export function mediaForUrl(value) {
  const safe = safeWebUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  let id;
  if (['youtu.be', 'www.youtu.be'].includes(host)) id = path[0];
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
    id = path[0] === 'watch' ? url.searchParams.get('v') : ['embed', 'shorts', 'live'].includes(path[0]) ? path[1] : null;
  }
  if (/^[\w-]{11}$/.test(id || '')) {
    const start = startSeconds(url.searchParams.get('start') || url.searchParams.get('t') || new URLSearchParams(url.hash.slice(1)).get('t'));
    return {
      kind: 'iframe', provider: 'YouTube',
      src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1${start ? `&start=${start}` : ''}`,
      image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
    };
  }
  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) {
    const match = /^\/(?:video\/)?(\d+)(?:\/([a-zA-Z0-9]+))?\/?$/.exec(url.pathname);
    if (match) {
      const query = new URLSearchParams({ autoplay: '1' });
      const hash = url.searchParams.get('h') || match[2];
      if (hash) query.set('h', hash);
      return { kind: 'iframe', provider: 'Vimeo', src: `https://player.vimeo.com/video/${match[1]}?${query}` };
    }
  }
  if (/\.(mp4|webm|ogv)$/i.test(url.pathname)) return { kind: 'video', provider: 'Video', src: safe };
  if (/\.(mp3|m4a|ogg|wav|oga)$/i.test(url.pathname)) return { kind: 'audio', provider: 'Audio', src: safe };
  return null;
}

const withoutHash = (value) => {
  const safe = safeWebUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = '';
  return url.href;
};

export function postLinkPreviews(post = {}) {
  const links = [...new Set(textLinkParts(post.content || '').filter((part) => part.url).map((part) => part.url))];
  return links.slice(0, 3).map((url) => {
    const media = mediaForUrl(url);
    const hasMetadata = withoutHash(url) === withoutHash(post.link_meta_url || post.link_url);
    const host = new URL(url).hostname.replace(/^www\./, '');
    return {
      url, media, host,
      title: (hasMetadata && post.link_meta_title) || (media ? (media.kind === 'iframe' ? `${media.provider} video` : media.kind === 'audio' ? 'Audio recording' : 'Video') : host),
      description: (hasMetadata && post.link_meta_description) || '',
      site: (hasMetadata && post.link_meta_site_name) || media?.provider || host,
      image: (hasMetadata && safeWebUrl(post.link_meta_image_url)) || media?.image || null
    };
  });
}
