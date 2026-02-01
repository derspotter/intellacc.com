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

  return div({ class: 'payment-verification' },
    div({ class: 'verification-icon' }, 'CARD'),
    h3('Verify a Payment Method'),

    () => {
      if (status.val === 'loading') {
        return div({ class: 'loading-state' },
          div({ class: 'spinner' }),
          p('Preparing secure payment form...')
        );
      }

      if (status.val === 'processing') {
        return div({ class: 'loading-state' },
          div({ class: 'spinner' }),
          p('Confirming your payment method...')
        );
      }

      if (status.val === 'success') {
        return div({ class: 'success-state' },
          div({ class: 'success-icon' }, 'OK'),
          p({ class: 'success-message' }, 'Payment method verified successfully!'),
          p({ class: 'instructions' },
            'Your verification will update shortly once Stripe confirms the setup.'
          )
        );
      }

      return div({ class: 'payment-form' },
        p({ class: 'description' },
          'Verify a payment method to unlock market creation and governance features. No charges are made.'
        ),
        status.val === 'ready' ? div({ class: 'payment-form-body' },
          paymentContainer,
          button({
            type: 'button',
            class: 'btn btn-primary',
            onclick: confirmPayment,
            disabled: status.val === 'processing'
          }, 'Confirm Verification')
        ) : button({
          type: 'button',
          class: 'btn btn-primary',
          onclick: setupPayment,
          disabled: status.val === 'loading' || status.val === 'processing'
        }, 'Start Payment Verification'),
        () => error.val ? p({ class: 'error-message' }, error.val) : null
      );
    }
  );
}
