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
  children,
  ariaLabel = null // Add aria-label for accessibility
}) {
  // Handle reactive className functions
  const computeClass = () => {
    const resolvedClassName = typeof className === 'function' ? className() : className;
    const buttonClass = ['button', variant ? `button-${variant}` : '', resolvedClassName]
      .filter(Boolean) // Remove empty strings
      .join(' '); // Join with spaces
    return buttonClass;
  };

  const buttonProps = {
    type,
    onclick,
    disabled,
    class: typeof className === 'function' ? computeClass : computeClass(), // Use reactive class if function
    style: 'touch-action: manipulation;' // Improve touch response
  };
  
  // Add aria-label if provided
  if (ariaLabel) {
    buttonProps['aria-label'] = ariaLabel;
  }

  return button(buttonProps, children);
}