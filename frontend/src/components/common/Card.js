import van from 'vanjs-core';
const { div } = van.tags;

/**
 * A reusable card component for consistent styling
 * @param {Object} props - Component properties
 * @param {string} props.title - Optional card title
 * @param {string} props.className - Additional CSS classes
 * @param {any} props.children - Card content
 */
export default function Card({ title, className = '', children }) {
  return div({ class: `card ${className}` }, [
    title ? div({ class: "card-title" }, title) : null,
    div({ class: "card-content" }, children)
  ]);
}