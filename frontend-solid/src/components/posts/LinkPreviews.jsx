import { createMemo, createSignal, For, Show } from 'solid-js';
import { postLinkPreviews } from '../../lib/linkPreviews';
import './linkPreviews.css';

function LinkPreview(props) {
  const [playing, setPlaying] = createSignal(false);
  const [failedImage, setFailedImage] = createSignal(null);
  const preview = () => props.preview;
  const image = () => preview().image && failedImage() !== preview().image;
  return (
    <article class="link-preview" data-testid="link-preview">
      <Show when={playing() && preview().media} fallback={
        <Show when={preview().media} fallback={
          <Show when={image()}>
            <a href={preview().url} target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">
              <img class="link-preview-image" src={preview().image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedImage(preview().image)} />
            </a>
          </Show>
        }>
          <button class="link-preview-play" type="button" aria-label={`Play ${preview().title}`} onClick={() => setPlaying(true)}>
            <Show when={image()}>
              <img class="link-preview-image" src={preview().image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedImage(preview().image)} />
            </Show>
            <span class="link-preview-play-label"><span aria-hidden="true">▶ </span>Play {preview().media.provider}</span>
          </button>
        </Show>
      }>
        <Show when={preview().media.kind === 'iframe'}>
          {/* YouTube requires the embedding origin even when the site uses no-referrer. */}
          <iframe class="link-preview-player" src={preview().media.src} title={preview().title}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin" />
        </Show>
        <Show when={preview().media.kind === 'video'}>
          <video class="link-preview-player" src={preview().media.src} controls autoplay playsinline preload="none" />
        </Show>
        <Show when={preview().media.kind === 'audio'}>
          <audio class="link-preview-audio" src={preview().media.src} controls autoplay preload="none" />
        </Show>
      </Show>
      <a class="link-preview-details" href={preview().url} target="_blank" rel="noopener noreferrer">
        <span class="link-preview-site">{preview().site}</span>
        <strong>{preview().title}</strong>
        <Show when={preview().description}><span class="link-preview-description">{preview().description}</span></Show>
        <span class="link-preview-url">{preview().host} ↗</span>
      </a>
      <Show when={playing()}>
        <div class="link-preview-controls">
          <button type="button" onClick={() => setPlaying(false)}>Close player</button>
          <a href={preview().url} target="_blank" rel="noopener noreferrer">Open original ↗</a>
        </div>
      </Show>
    </article>
  );
}

export default function LinkPreviews(props) {
  const previews = createMemo(() => postLinkPreviews(props.post));
  // Key by URL so unrelated post updates (likes/comments/metadata) keep playback alive.
  const urls = createMemo(() => previews().map((preview) => preview.url));
  return <div class="post-link-previews"><For each={urls()}>{(url) =>
    <LinkPreview preview={previews().find((preview) => preview.url === url)} />
  }</For></div>;
}
