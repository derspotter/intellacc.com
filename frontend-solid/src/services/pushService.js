import { api } from './api';

const PUSH_DISMISSED_KEY = 'push_notification_dismissed';
const PUSH_ASKED_KEY = 'push_notification_asked';

export const isPushSupported = () => {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
};

export const getPermissionStatus = () => {
  if (!isPushSupported()) {
    return 'denied';
  }

  return Notification.permission;
};

export const setDismissed = (value) => {
  if (!window?.localStorage) return;

  if (value) {
    window.localStorage.setItem(PUSH_DISMISSED_KEY, 'true');
  } else {
    window.localStorage.removeItem(PUSH_DISMISSED_KEY);
  }
};

export const registerServiceWorker = async () => {
  if (!isPushSupported()) {
    return null;
  }

  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((registration) => registration.unregister()));
    } catch (error) {
      console.warn('[PushService] Failed to clear localhost SW registrations:', error);
    }
    return null;
  }

  try {
    return navigator.serviceWorker.register('/sw.js');
  } catch (error) {
    console.error('[PushService] Service worker registration failed:', error);
    return null;
  }
};

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
};

export const getSubscriptionState = async () => {
  if (!isPushSupported()) {
    return { supported: false, subscribed: false, permission: 'denied' };
  }

  try {
    const permission = getPermissionStatus();
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return {
      supported: true,
      subscribed: !!subscription,
      permission,
      endpoint: subscription?.endpoint
    };
  } catch (error) {
    console.error('[PushService] Failed to read subscription state:', error);
    return { supported: true, subscribed: false, permission: getPermissionStatus() };
  }
};

export const getSubscription = async () => {
  if (!isPushSupported()) return null;

  try {
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  } catch (error) {
    console.error('[PushService] Failed to get subscription:', error);
    return null;
  }
};

export const subscribeToPush = async () => {
  if (!isPushSupported()) {
    throw new Error('Push notifications not supported');
  }

  if (Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('Notification permission denied');
    }
  }

  try {
    const { publicKey } = await api.push.getVapidKey();
    if (!publicKey) {
      throw new Error('Push notifications are not configured');
    }

    const registration = await registerServiceWorker();
    const swReg = registration || (await navigator.serviceWorker.ready);
    const subscription = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    await api.push.subscribe(subscription.toJSON());
    setDismissed(false);

    return subscription;
  } catch (error) {
    console.error('[PushService] Subscribe failed:', error);
    throw error;
  }
};

export const unsubscribeFromPush = async () => {
  try {
    const subscription = await getSubscription();
    if (!subscription) {
      return true;
    }

    await subscription.unsubscribe();
    await api.push.unsubscribe(subscription.endpoint);
    return true;
  } catch (error) {
    console.error('[PushService] Unsubscribe failed:', error);
    throw error;
  }
};

export const getPreferences = async () => {
  try {
    const { preferences } = await api.push.getPreferences();
    return preferences;
  } catch (error) {
    return { push_replies: true, push_follows: true, push_messages: true };
  }
};

export const updatePreferences = async (preferences) => {
  const { preferences: updated } = await api.push.updatePreferences(preferences);
  return updated;
};
