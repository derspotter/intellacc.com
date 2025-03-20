import van from 'vanjs-core';
const { div, label, input } = van.tags;

/**
 * Reusable input component with label
 */
export default function Input({
  id,
  type = 'text',
  label: labelText,
  value,
  onchange,
  required = false,
  placeholder = '',
  disabled = false
}) {
  return div({ class: "form-group" }, [
    label({ for: id }, labelText),
    input({
      type,
      id,
      value,
      required,
      placeholder,
      disabled,
      onchange
    })
  ]);
}