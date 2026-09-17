import { createEffect, createSignal } from 'solid-js';
import { parseBeliefPercent, formatBeliefPercent } from '../../lib/tradeBelief';

export default function ProbabilityInput(props) {
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal('');
  createEffect(() => {
    if (!editing()) setText(formatBeliefPercent(props.value, props.marketProb));
  });

  return (
    <input
      class="belief-probability-input"
      type="number"
      inputmode="decimal"
      min="1"
      max="99"
      step="any"
      required
      aria-label="Your belief probability (%)"
      value={text()}
      onFocus={() => setEditing(true)}
      onInput={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        const probability = parseBeliefPercent(next);
        if (probability !== null) props.onChange(probability);
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
