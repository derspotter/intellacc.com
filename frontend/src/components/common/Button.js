import van from 'vanjs-core';
const { button } = van.tags;

/**
 * Reusable button component
 */
export default function Button({
  onclick,
  disabled = false,
  type = 'button',
  className = '',
  variant = '', // Add variant prop
  children
}) {
  // Construct class string dynamically, including base, variant, and custom classes
  const buttonClass = ['button', variant ? `button-${variant}` : '', className]
    .filter(Boolean) // Remove empty strings
    .join(' '); // Join with spaces

  return button({
    type,
    onclick,
    disabled,
    class: buttonClass // Use the dynamically generated class string
  }, children);
}