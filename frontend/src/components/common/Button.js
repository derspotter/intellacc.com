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
  // Handle reactive className functions
  const computeClass = () => {
    const resolvedClassName = typeof className === 'function' ? className() : className;
    const buttonClass = ['button', variant ? `button-${variant}` : '', resolvedClassName]
      .filter(Boolean) // Remove empty strings
      .join(' '); // Join with spaces
    return buttonClass;
  };

  return button({
    type,
    onclick,
    disabled,
    class: typeof className === 'function' ? computeClass : computeClass() // Use reactive class if function
  }, children);
}