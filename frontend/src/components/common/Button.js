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
  children 
}) {
  return button({
    type,
    onclick,
    disabled,
    class: `button ${className}`
  }, children);
}