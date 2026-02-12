// frontend/src/services/pushService.js
// Service for managing Web Push notifications

import { api } from './api.js';

// Storage key for dismissal state
const PUSH_DISMISSED_KEY = 'push_notification_dismissed';
const PUSH_ASKED_KEY = 'push_notification_asked';

/**
 * Check if push notifications are supported in this browser
 */
export function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Get the current notification permission status
 * @returns {'default' | 'granted' | 'denied'}
 */
export function getPermissionStatus() {
  if (!isPushSupported()) return 'denied';
  return Notification.permission;
}

/**
 * Check if the user has dismissed the push notification prompt
 */
export function isDismissed() {
  return localStorage.getItem(PUSH_DISMISSED_KEY) === 'true';
}

/**
 * Set the dismissed state
 */
export function setDismissed(value) {
  if (value) {
    localStorage.setItem(PUSH_DISMISSED_KEY, 'true');
  } else {
    localStorage.removeItem(PUSH_DISMISSED_KEY);
  }
}

/**
 * Check if we've already asked the user
 */
export function hasAsked() {
  return localStorage.getItem(PUSH_ASKED_KEY) === 'true';
}

/**
 * Mark that we've asked the user
 */
export function markAsked() {
  localStorage.setItem(PUSH_ASKED_KEY, 'true');
}

/**
 * Check if we should show the push notification prompt
 */
export function shouldShowPrompt() {
  if (!isPushSupported()) return false;
  if (isDismissed()) return false;
  if (getPermissionStatus() === 'denied') return false;
  if (getPermissionStatus() === 'granted') return false;
  return true;
}

/**
 * Convert a base64 string to Uint8Array (for VAPID key)
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Register the service worker
 */
export async function registerServiceWorker() {
  if (!isPushSupported()) {
    console.log('[Push] Service workers not supported');
    return null;
  }

  // In local dev, stale SW caches can serve old JS and make auth flows appear broken.
  // Keep localhost uncached and unregister any leftover service workers.
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
      console.log('[Push] Skipping service worker on localhost and cleared existing registrations');
    } catch (error) {
      console.warn('[Push] Failed clearing localhost service workers:', error);
    }
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('[Push] Service worker registered:', registration.scope);
    return registration;
  } catch (error) {
    console.error('[Push] Service worker registration failed:', error);
    return null;
  }
}

/**
 * Get the current push subscription
 */
export async function getSubscription() {
  if (!isPushSupported()) return null;

  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch (error) {
    console.error('[Push] Error getting subscription:', error);
    return null;
  }
}

/**
 * Request notification permission
 */
export async function requestPermission() {
  if (!isPushSupported()) {
    return 'denied';
  }

  markAsked();
  const permission = await Notification.requestPermission();
  console.log('[Push] Permission result:', permission);
  return permission;
}

/**
 * Subscribe to push notifications
 */
export async function subscribeToPush() {
  if (!isPushSupported()) {
    throw new Error('Push notifications not supported');
  }

  // Check permission
  if (Notification.permission !== 'granted') {
    const permission = await requestPermission();
    if (permission !== 'granted') {
      throw new Error('Notification permission denied');
    }
  }

  try {
    // Get VAPID key from server
    const { publicKey } = await api.push.getVapidKey();
    if (!publicKey) {
      throw new Error('Push notifications not configured on server');
    }

    // Register service worker if not already registered
    const registration = await navigator.serviceWorker.ready;

    // Subscribe to push
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    console.log('[Push] Subscribed:', subscription.endpoint);

    // Send subscription to server
    await api.push.subscribe(subscription.toJSON());

    // Clear dismissed state since user actively subscribed
    setDismissed(false);

    return subscription;
  } catch (error) {
    console.error('[Push] Subscribe error:', error);
    throw error;
  }
}

/**
 * Unsubscribe from push notifications
 */
export async function unsubscribeFromPush() {
  try {
    const subscription = await getSubscription();
    if (!subscription) {
      console.log('[Push] No subscription to remove');
      return true;
    }

    // Unsubscribe from browser
    await subscription.unsubscribe();

    // Remove from server
    await api.push.unsubscribe(subscription.endpoint);

    console.log('[Push] Unsubscribed');
    return true;
  } catch (error) {
    console.error('[Push] Unsubscribe error:', error);
    throw error;
  }
}

/**
 * Get subscription state for UI
 */
export async function getSubscriptionState() {
  if (!isPushSupported()) {
    return { supported: false, subscribed: false, permission: 'denied' };
  }

  const permission = getPermissionStatus();
  const subscription = await getSubscription();

  return {
    supported: true,
    subscribed: !!subscription,
    permission,
    endpoint: subscription?.endpoint
  };
}

/**
 * Get notification preferences from server
 */
export async function getPreferences() {
  try {
    const { preferences } = await api.push.getPreferences();
    return preferences;
  } catch (error) {
    console.error('[Push] Error getting preferences:', error);
    return {
      push_replies: true,
      push_follows: true,
      push_messages: true
    };
  }
}

/**
 * Update notification preferences on server
 */
export async function updatePreferences(preferences) {
  try {
    const { preferences: updated } = await api.push.updatePreferences(preferences);
    return updated;
  } catch (error) {
    console.error('[Push] Error updating preferences:', error);
    throw error;
  }
}
