import { For } from 'solid-js';

export function RenderTextWithLinks(props) {
  const parts = () => {
    const text = props.text;
    if (!text) return [];
    
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.split(urlRegex);
  };
  
  return (
    <For each={parts()}>
      {(part) => {
        if (part.match(/^https?:\/\//)) {
          return <a href={part} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-color, #007bff)", "text-decoration": "underline" }}>{part}</a>;
        }
        return part;
      }}
    </For>
  );
}