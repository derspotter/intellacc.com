export default function Card({ title, className = '', children }) {
  const resolvedClassName = `card ${className || ''}`.trim();

  return (
    <div class={resolvedClassName}>
      {title ? <div class="card-title">{title}</div> : null}
      <div class="card-content">{children}</div>
    </div>
  );
}

