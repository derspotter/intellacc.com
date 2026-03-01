const resolveClassName = (className) => {
  const baseClass = ['button'];
  if (typeof className === 'function') {
    const dynamic = className();
    if (dynamic) {
      baseClass.push(dynamic);
    }
    return baseClass.join(' ');
  }

  if (className) {
    baseClass.push(className);
  }

  return baseClass.join(' ');
};

const resolveDisabled = (disabled) => {
  if (typeof disabled === 'function') {
    return () => Boolean(disabled());
  }
  return Boolean(disabled);
};

export default function Button({
  type = 'button',
  className = '',
  variant = '',
  disabled = false,
  onclick,
  ariaLabel = null,
  children
}) {
  const isClassNameFunction = typeof className === 'function';
  const staticClassName = typeof className === 'string' ? className : '';
  const classes = () => {
    const variantClass = variant ? `button-${variant}` : '';
    const userClass = isClassNameFunction ? resolveClassName(className) : staticClassName;

    if (isClassNameFunction) {
      const next = resolveClassName(className);
      return variantClass ? `${next} ${variantClass}`.trim() : next;
    }

    const list = ['button'];
    if (variantClass) list.push(variantClass);
    if (userClass) list.push(userClass);
    return list.join(' ');
  };

  return (
    <button
      type={type}
      class={isClassNameFunction ? classes : classes()}
      disabled={resolveDisabled(disabled)}
      aria-label={ariaLabel || undefined}
      onclick={onclick}
      style={{ 'touch-action': 'manipulation' }}
    >
      {children}
    </button>
  );
}
