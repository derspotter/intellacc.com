import { For } from 'solid-js';
import { textLinkParts } from '../lib/linkPreviews';

export function RenderTextWithLinks(props) {
  const parts = () => {
    const text = props.text;
    if (!text) return [];
    
    return textLinkParts(text);
  };
  
  return (
    <For each={parts()}>
      {(part) => {
        if (part.url) {
          return <a href={part.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-color, #007bff)", "text-decoration": "underline" }}>{part.text}</a>;
        }
        return part.text;
      }}
    </For>
  );
}
