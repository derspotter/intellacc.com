import { createSignal, onCleanup, Show } from 'solid-js';
import { api } from '../../services/api';

let stripeJsPromise = null;

const loadStripeJs = () => {
  if (stripeJsPromise) {
    return stripeJsPromise;
  }

  stripeJsPromise = new Promise((resolve, reject) => {
    if (window.Stripe) {
      resolve(window.Stripe);
      return;
    }

    const existing = document.querySelector('script[data-stripe-js]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Stripe));
      existing.addEventListener('error', () => reject(new Error('Failed to load Stripe.js')));
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.async = true;
    script.dataset.stripeJs = 'true';
    script.onload = () => resolve(window.Stripe);
    script.onerror = () => reject(new Error('Failed to load Stripe.js'));
    document.head.appendChild(script);
  });

  return stripeJsPromise;
};

export default function PaymentVerification({ onSuccess } = {}) {
  const [status, setStatus] = createSignal('idle');
  const [error, setError] = createSignal('');
  const [paymentContainer, setPaymentContainer] = createSignal(null);

  let stripeInstance = null;
  let elementsInstance = null;
  let paymentElement = null;

  const setupPayment = async () => {
    setStatus('loading');
    setError('');
    try {
      const result = await api.verification.createPaymentSetup();
      if (!result?.publishableKey || !result?.clientSecret) {
        throw new Error('Payment verification is not configured');
      }

      await loadStripeJs();
      stripeInstance = window.Stripe(result.publishableKey);
      elementsInstance = stripeInstance.elements({ clientSecret: result.clientSecret });

      if (paymentElement) {
        paymentElement.unmount();
      }

      paymentElement = elementsInstance.create('payment');
      paymentElement.mount(paymentContainer());
      setStatus('ready');
    } catch (err) {
      setError(err?.data?.error || err?.message || 'Failed to start payment verification');
      setStatus('error');
    }
  };

  const confirmPayment = async () => {
    if (!stripeInstance || !elementsInstance) {
      setError('Payment form not ready.');
      setStatus('error');
      return;
    }

    setStatus('processing');
    setError('');
    try {
      const result = await stripeInstance.confirmSetup({
        elements: elementsInstance,
        confirmParams: {
          return_url: `${window.location.origin}/#settings/verification`,
          redirect: 'if_required'
        }
      });

      if (result.error) {
        setStatus('error');
        setError(result.error.message || 'Verification failed');
        return;
      }

      setStatus('success');
      onSuccess?.();
    } catch (err) {
      setStatus('error');
      setError(err?.message || 'Verification failed');
    }
  };

  onCleanup(() => {
    if (paymentElement) {
      paymentElement.unmount();
      paymentElement = null;
    }
  });

  return (
    <section class="payment-verification">
      <div class="verification-icon">💳</div>
      <h3>Verify a payment method</h3>
      <Show when={status() === 'loading'}>
        <div class="loading-state">
          <div class="spinner" />
          <p>Preparing secure payment form...</p>
        </div>
      </Show>
      <Show when={status() === 'processing'}>
        <div class="loading-state">
          <div class="spinner" />
          <p>Confirming your payment method...</p>
        </div>
      </Show>
      <Show when={status() === 'success'}>
        <div class="success-state">
          <div class="success-icon">✓</div>
          <p class="success-message">Payment method verified.</p>
          <p class="instructions">This will update shortly once Stripe confirms.</p>
        </div>
      </Show>
      <Show when={['idle', 'ready', 'error'].includes(status())}>
        <div class="payment-form">
          <p class="description">Verify payment to unlock market creation and governance actions.</p>
          {status() === 'ready' ? (
            <>
              <div class="payment-form-body" ref={setPaymentContainer} />
              <button type="button" class="btn btn-primary" onClick={confirmPayment}>
                Confirm verification
              </button>
            </>
          ) : (
            <button type="button" class="btn btn-primary" onClick={setupPayment} disabled={status() === 'loading'}>
              Start payment verification
            </button>
          )}
          <Show when={error()}>
            <p class="error-message">{error()}</p>
          </Show>
        </div>
      </Show>
    </section>
  );
}
