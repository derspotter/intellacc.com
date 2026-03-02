/**
 * Payment Verification Component
 * Uses Stripe SetupIntent to verify a payment method
 */
import van from 'vanjs-core';
import api from '../../services/api.js';

const { div, h3, p, button } = van.tags;

let stripeJsPromise = null;

const loadStripeJs = () => {
  if (stripeJsPromise) return stripeJsPromise;

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
  const status = van.state('idle'); // idle | loading | ready | processing | success | error
  const error = van.state('');
  const paymentContainer = div({ class: 'payment-element' });

  let stripeInstance = null;
  let elementsInstance = null;
  let paymentElement = null;

  const setupPayment = async () => {
    status.val = 'loading';
    error.val = '';

    try {
      const result = await api.verification.createPaymentSetup();

      if (!result.publishableKey || !result.clientSecret) {
        throw new Error('Payment verification is not configured');
      }

      await loadStripeJs();
      stripeInstance = window.Stripe(result.publishableKey);
      elementsInstance = stripeInstance.elements({ clientSecret: result.clientSecret });

      if (paymentElement) {
        paymentElement.unmount();
      }

      paymentElement = elementsInstance.create('payment');
      paymentElement.mount(paymentContainer);
      status.val = 'ready';
    } catch (err) {
      console.error('[PaymentVerification] Setup error:', err);
      status.val = 'error';
      error.val = err.data?.error || err.message || 'Failed to start payment verification';
    }
  };

  const confirmPayment = async () => {
    if (!stripeInstance || !elementsInstance) {
      error.val = 'Payment form not ready yet';
      status.val = 'error';
      return;
    }

    status.val = 'processing';
    error.val = '';

    try {
      const result = await stripeInstance.confirmSetup({
        elements: elementsInstance,
        confirmParams: {
          return_url: window.location.origin + '/#settings/verification'
        },
        redirect: 'if_required'
      });

      if (result.error) {
        status.val = 'error';
        error.val = result.error.message || 'Verification failed';
        return;
      }

      status.val = 'success';
      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('[PaymentVerification] Confirm error:', err);
      status.val = 'error';
      error.val = err.message || 'Verification failed';
    }
  };

  return div({ class: 'payment-verification', style: 'text-align: left; padding: 1rem 0;' },
    div({ class: 'verification-icon', style: 'font-size: 2rem; margin-bottom: 0.5rem;' }, '💳'),
    h3({ style: 'margin-top: 0; margin-bottom: 0.5rem;' }, 'Verify a Payment Method'),

    () => {
      if (status.val === 'loading') {
        return div({ class: 'loading-state', style: 'text-align: left;' },
          div({ class: 'spinner', style: 'margin-bottom: 0.5rem;' }),
          p({ style: 'margin: 0;' }, 'Preparing secure payment form...')
        );
      }

      if (status.val === 'processing') {
        return div({ class: 'loading-state', style: 'text-align: left;' },
          div({ class: 'spinner', style: 'margin-bottom: 0.5rem;' }),
          p({ style: 'margin: 0;' }, 'Confirming your payment method...')
        );
      }

      if (status.val === 'success') {
        return div({ class: 'success-state', style: 'text-align: left; padding: 1rem 0;' },
          div({ class: 'success-icon', style: 'display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: var(--success-color); color: white; border-radius: 50%; margin-bottom: 0.5rem;' }, '✓'),
          p({ class: 'success-message', style: 'margin-bottom: 0.5rem;' }, 'Payment method verified successfully!'),
          p({ class: 'instructions', style: 'margin-bottom: 0;' },
            'Your verification will update shortly once Stripe confirms the setup.'
          )
        );
      }

      return div({ class: 'payment-form', style: 'text-align: left;' },
        p({ class: 'description', style: 'margin-bottom: 1rem;' },
          'Verify a payment method to unlock market creation and governance features. No charges are made.'
        ),
        status.val === 'ready' ? div({ class: 'payment-form-body' },
          paymentContainer,
          button({
            type: 'button',
            class: 'button button-primary',
            style: 'margin-top: 1rem;',
            onclick: confirmPayment,
            disabled: status.val === 'processing'
          }, 'Confirm Verification')
        ) : button({
          type: 'button',
          class: 'button button-primary',
          onclick: setupPayment,
          disabled: status.val === 'loading' || status.val === 'processing'
        }, 'Start Payment Verification'),
        () => error.val ? p({ class: 'error-message', style: 'margin-top: 1rem;' }, error.val) : null
      );
    }
  );
}
