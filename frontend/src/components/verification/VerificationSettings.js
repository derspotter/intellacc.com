/**
 * Verification Settings Section
 * Combines status and upgrade flows
 */
import van from 'vanjs-core';
import api from '../../services/api.js';
import userStore from '../../store/user';
import EmailVerification from './EmailVerification.js';
import PhoneVerification from './PhoneVerification.js';
import PaymentVerification from './PaymentVerification.js';

const { div, h3, p, button, span } = van.tags;

export default function VerificationSettings() {
  const status = van.state(null);
  const loading = van.state(true);
  const error = van.state('');
  const activeStep = van.state('email');

  const refreshStatus = async () => {
    loading.val = true;
    error.val = '';
    try {
      const result = await api.verification.getStatus();
      status.val = result;
      const nextKey =
        result?.email_verified !== true
          ? 'email'
          : result?.phone_verified !== true
            ? 'phone'
            : result?.payment_verified !== true
              ? 'payment'
              : 'payment';

      if (!activeStep.val || (result?.[`${activeStep.val}_verified`] === true)) {
        activeStep.val = nextKey;
      }
    } catch (err) {
      console.error('[VerificationSettings] Error:', err);
      error.val = err.data?.error || err.message || 'Failed to load verification status';
    } finally {
      loading.val = false;
    }
  };

  refreshStatus();

  const isProviderAvailable = (providerKey) => {
    const provider = status.val?.provider_capabilities?.[providerKey];
    return provider?.available !== false;
  };

  const getProviderReason = (providerKey) => {
    const provider = status.val?.provider_capabilities?.[providerKey];
    return provider?.reason || 'Check back later or contact support.';
  };

  const currentTier = () => status.val?.current_tier || 0;

  const verificationSteps = () => ([
    {
      key: 'email',
      label: 'Email',
      tier: 1,
      completed: status.val?.email_verified === true,
      blocked: false,
      unavailable: false
    },
    {
      key: 'phone',
      label: 'Phone',
      tier: 2,
      completed: status.val?.phone_verified === true,
      blocked: status.val?.email_verified !== true,
      unavailable: !isProviderAvailable('phone')
    },
    {
      key: 'payment',
      label: 'Payment',
      tier: 3,
      completed: status.val?.payment_verified === true,
      blocked: status.val?.phone_verified !== true,
      unavailable: !isProviderAvailable('payment')
    }
  ]);

  const renderStepContent = () => {
    if (loading.val) {
      return p({ class: 'loading' }, 'Loading verification steps...');
    }

    if (error.val) {
      return div({ class: 'error-message' },
        p(error.val),
        button({ type: 'button', class: 'btn btn-sm', onclick: refreshStatus }, 'Retry')
      );
    }

    const step = verificationSteps().find((item) => item.key === activeStep.val) || verificationSteps()[0];

    if ((status.val?.current_tier || 0) >= 3) {
      return div({ class: 'success-state' },
        div({ class: 'success-icon' }, 'OK'),
        p({ class: 'success-message' }, 'All verification tiers complete.')
      );
    }

    if (!step) {
      return null;
    }

    if (step.completed) {
      return div({ class: 'verification-step-complete' },
        p(
          span({ class: 'step-complete-mark' }, '✓ '),
          `${step.label} verification is complete.`
        )
      );
    }

    if (step.key === 'phone' && step.blocked) {
      return div({ class: 'verification-blocked' },
        p({ class: 'error-message' }, 'Phone verification is available after email verification.')
      );
    }

    if (step.key === 'payment' && step.blocked) {
      return div({ class: 'verification-blocked' },
        p({ class: 'error-message' }, 'Payment verification is available after phone verification.')
      );
    }

    if (step.key === 'phone' && step.unavailable) {
      return div({ class: 'verification-blocked' },
        div({ class: 'blocked-icon' }, '⚠️'),
        p({ class: 'error-message' }, 'Phone verification is unavailable right now.'),
        p({ class: 'blocked-message' }, getProviderReason('phone'))
      );
    }

    if (step.key === 'payment' && step.unavailable) {
      return div({ class: 'verification-blocked' },
        div({ class: 'blocked-icon' }, '⚠️'),
        p({ class: 'error-message' }, 'Payment verification is unavailable right now.'),
        p({ class: 'blocked-message' }, getProviderReason('payment'))
      );
    }

    if (step.key === 'email') {
      return EmailVerification({ userEmail: userStore.state.profile.val?.email });
    }

    if (step.key === 'phone') {
      return PhoneVerification({ onSuccess: refreshStatus });
    }

    if (step.key === 'payment') {
      return PaymentVerification({ onSuccess: refreshStatus });
    }

    return null;
  };

  return div({ class: 'settings-section verification-settings' },
    h3({ class: 'settings-section-title' }, 'Verification'),
    div({ class: 'verification-content' },
      div({ class: 'verification-summary-row' },
        div({ class: 'verification-tier-pill' }, () => `Current tier: ${currentTier()} / 3`),
        button({
          type: 'button',
          class: 'btn btn-secondary btn-sm verification-refresh',
          onclick: refreshStatus
        }, 'Refresh Status')
      ),
      () => div({ class: 'verification-step-tabs' },
        ...verificationSteps().map((step) => button({
          type: 'button',
          class: `verification-step-tab ${activeStep.val === step.key ? 'active' : ''} ${step.completed ? 'complete' : ''}`,
          onclick: () => { activeStep.val = step.key; }
        }, `${step.label}${step.completed ? ' ✓' : ''}`))
      ),
      () => div({ class: 'verification-step-panel' }, renderStepContent())
    )
  );
}
