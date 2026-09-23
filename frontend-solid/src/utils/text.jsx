import { createMemo, For, Show } from 'solid-js';
import { textLinkParts } from '../lib/linkPreviews';
import { renderMarkdown } from '../lib/markdown';
import './text.css';

export function RenderTextWithLinks(props) {
  const html = createMemo(() => props.markdown ? renderMarkdown(props.text) : '');
  const parts = () => {
    const text = props.text;
    if (!text) return [];
    
    return textLinkParts(text);
  };
  
  return (
    <Show when={props.markdown} fallback={<For each={parts()}>
      {(part) => {
        if (part.url) {
          return <a href={part.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-color, #007bff)", "text-decoration": "underline" }}>{part.text}</a>;
        }
        return part.text;
      }}
    </For>}>
      <div class={`${props.class || ''} formatted-markdown`} innerHTML={html()} />
    </Show>
  );
}
