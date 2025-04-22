import van from 'vanjs-core';
const { textarea, input } = van.tags;

/**
 * Reusable text input/textarea component
 * @param {Object} props - Component properties
 * @param {'text' | 'textarea'} props.type - Type of input ('text' or 'textarea')
 * @param {string} props.placeholder - Placeholder text
 * @param {van.State<string>} props.value - Van state for the input value
 * @param {function} props.oninput - Input event handler
 * @param {string} [props.className=''] - Additional CSS classes
 * @param {number} [props.rows] - Number of rows for textarea type
 */
export default function TextInput({
  type = 'text',
  placeholder = '',
  value, // van.state
  oninput,
  className = '',
  rows
}) {
  const commonProps = {
    placeholder,
    value,
    oninput: oninput ? (e) => oninput(e.target.value) : null, // Pass value directly
    class: `text-input ${className}` // Add a base class
  };

  if (type === 'textarea') {
    return textarea({
      ...commonProps,
      rows: rows || 3 // Default rows for textarea
    });
  } else {
    return input({
      ...commonProps,
      type: 'text' // Ensure type is text for input
    });
  }
}