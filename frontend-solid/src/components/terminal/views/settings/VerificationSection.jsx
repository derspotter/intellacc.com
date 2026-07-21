import { Show, createSignal, onMount } from 'solid-js';
import { api } from '../../../../services/api';

export default function VerificationSection() {
  const [status, setStatus] = createSignal(null);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(() => {
    api.verification.getStatus()
      .then((s) => setStatus(s || {}))
      .catch((e) => setError(e?.message || 'FAILED TO LOAD VERIFICATION STATUS'));
  });

  const sendVerification = async () => {
    setError('');
    try {
      await api.verification.sendEmailVerification();
      setSent(true);
    } catch (e) {
      setError(e?.message || 'FAILED TO SEND VERIFICATION EMAIL');
    }
  };

  return (
    <div class="text-xs">
      <Show when={status()} fallback={<div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>}>
        <div class="text-bb-text">TIER: {status().current_tier ?? 0}</div>
        <Show when={(status().current_tier ?? 0) === 0}>
          <button
            type="button"
            onClick={sendVerification}
            class="mt-2 text-bb-accent hover:underline uppercase font-bold"
          >
            [VERIFY EMAIL]
          </button>
          <Show when={sent()}>
            <span class="ml-2 text-market-up">VERIFICATION EMAIL SENT</span>
          </Show>
        </Show>
      </Show>
      <Show when={error()}>
        <div class="mt-2 text-market-down">ERROR // {error().toUpperCase()}</div>
      </Show>
    </div>
  );
}
