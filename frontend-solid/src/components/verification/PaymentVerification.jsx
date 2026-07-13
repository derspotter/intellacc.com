import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { api } from '../../services/api';

const PAYPAL_PENDING_KEY = 'paypal_verification_setup_token';

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

export default function PaymentVerification({ onSuccess, paypalAvailable } = {}) {
  const [status, setStatus] = createSignal('idle');
  const [error, setError] = createSignal('');
  const [paymentContainer, setPaymentContainer] = createSignal(null);

  let stripeInstance = null;
  let elementsInstance = null;
  let paymentElement = null;

  // PayPal vault flow: redirect out for approval, confirm on return. The
  // pending setup token survives the round trip in sessionStorage.
  const startPaypal = async () => {
    setStatus('loading');
    setError('');
    try {
      const result = await api.verification.createPaypalSetup();
      if (!result?.approveUrl || !result?.setupTokenId) {
        throw new Error('PayPal verification is not configured');
      }
      sessionStorage.setItem(PAYPAL_PENDING_KEY, result.setupTokenId);
      window.location.href = result.approveUrl;
    } catch (err) {
      setError(err?.data?.error || err?.message || 'Failed to start PayPal verification');
      setStatus('error');
    }
  };

  onMount(async () => {
    const pendingToken = sessionStorage.getItem(PAYPAL_PENDING_KEY);
    if (!pendingToken) return;
    sessionStorage.removeItem(PAYPAL_PENDING_KEY);
    setStatus('processing');
    try {
      await api.verification.confirmPaypalSetup(pendingToken);
      setStatus('success');
      onSuccess?.();
    } catch (err) {
      setError(err?.data?.error || err?.message || 'PayPal approval was not completed');
      setStatus('error');
    }
  });

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

      // The mount target (.payment-form-body) only renders in the 'ready'
      // state, so flip status BEFORE mounting — Solid renders synchronously,
      // making the ref available on the next line. Mounting first (as this
      // originally did) always passed a null container and threw.
      setStatus('ready');
      const container = paymentContainer();
      if (!container) {
        throw new Error('Payment form container failed to render');
      }
      paymentElement = elementsInstance.create('payment');
      paymentElement.mount(container);
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
      // `redirect` is a top-level confirmSetup option; inside confirmParams
      // it is forwarded to the API, which rejects it as an unknown parameter.
      const result = await stripeInstance.confirmSetup({
        elements: elementsInstance,
        redirect: 'if_required',
        confirmParams: {
          return_url: `${window.location.origin}/#settings/verification`
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
    <section class="payment-verification" style="text-align: left; padding: 1rem 0;">
      <div class="verification-icon" style="font-size: 2rem; margin-bottom: 0.5rem;"></div>
      <h3 style="margin-top: 0; margin-bottom: 0.5rem;">Verify a payment method</h3>
      <Show when={status() === 'loading'}>
        <div class="loading-state" style="text-align: left;">
          <div class="spinner" style="margin-bottom: 0.5rem;" />
          <p style="margin: 0;">Preparing secure payment form...</p>
        </div>
      </Show>
      <Show when={status() === 'processing'}>
        <div class="loading-state" style="text-align: left;">
          <div class="spinner" style="margin-bottom: 0.5rem;" />
          <p style="margin: 0;">Confirming your payment method...</p>
        </div>
      </Show>
      {/* The payment form must STAY MOUNTED during 'processing':
          stripe.confirmSetup reads from the live Element, and unmounting it
          on the status flip made confirmation fail unconditionally. */}
      <Show when={status() === 'success'}>
        <div class="success-state" style="text-align: left; padding: 1rem 0;">
          <div class="success-icon" style="display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: var(--success-color); color: white; border-radius: 50%; margin-bottom: 0.5rem;"></div>
          <p class="success-message" style="margin-bottom: 0.5rem;">Payment method verified.</p>
          <p class="instructions" style="margin-bottom: 0;">This will update shortly once Stripe confirms.</p>
        </div>
      </Show>
      <Show when={['idle', 'ready', 'error', 'processing'].includes(status())}>
        <div class="payment-form" style="text-align: left;">
          <p class="description" style="margin-bottom: 1rem;">Verify payment to unlock market creation and governance actions.</p>
          {['ready', 'processing'].includes(status()) ? (
            <>
              <div class="payment-form-body" ref={setPaymentContainer} />
              <button
                type="button"
                class="button button-primary"
                style="margin-top: 1rem;"
                onClick={confirmPayment}
                disabled={status() === 'processing'}
              >
                {status() === 'processing' ? 'Confirming…' : 'Confirm verification'}
              </button>
            </>
          ) : (
            <>
              <button type="button" class="button button-primary" onClick={setupPayment} disabled={status() === 'loading'}>
                Start payment verification
              </button>
              <Show when={paypalAvailable}>
                <button
                  type="button"
                  class="button button-secondary paypal-verify-btn"
                  style="margin-left: 0.5rem;"
                  onClick={startPaypal}
                  disabled={status() === 'loading'}
                >
                  Verify with PayPal
                </button>
              </Show>
            </>
          )}
          <Show when={error()}>
            <p class="error-message" style="margin-top: 1rem;">{error()}</p>
          </Show>
        </div>
      </Show>
    </section>
  );
}
