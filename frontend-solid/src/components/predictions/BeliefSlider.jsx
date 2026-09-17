import { snapBeliefToMarket } from '../../lib/tradeBelief';
import { beliefTrackGradient } from '../../lib/kellyStake';

export default function BeliefSlider(props) {
  return (
    <input
      type="range"
      min="0.01"
      max="0.99"
      step="any"
      class={props.class || 'belief-slider'}
      style={{ background: beliefTrackGradient(props.marketProb, props.colors) }}
      aria-label="Your belief probability"
      value={props.value}
      onInput={(event) => {
        const value = snapBeliefToMarket(Number(event.currentTarget.value), props.marketProb);
        event.currentTarget.value = String(value);
        props.onChange(value);
      }}
      onKeyDown={(event) => {
        // Arrow keys must be able to leave the snap zone without getting stuck.
        const delta = { ArrowLeft: -0.01, ArrowDown: -0.01, ArrowRight: 0.01, ArrowUp: 0.01 }[event.key];
        if (delta === undefined) return;
        event.preventDefault();
        props.onChange(Math.min(0.99, Math.max(0.01, props.value + delta)));
      }}
    />
  );
}
