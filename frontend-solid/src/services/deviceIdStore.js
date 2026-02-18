const STORAGE_KEY = 'intellacc_device_id_solid';
let cachedDeviceId = null;

export const getDeviceId = () => {
  if (cachedDeviceId !== null) {
    return cachedDeviceId;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    cachedDeviceId = stored || null;
    return cachedDeviceId;
  } catch {
    return null;
  }
};

export const setDeviceId = (id) => {
  cachedDeviceId = id || null;
  try {
    if (cachedDeviceId) {
      localStorage.setItem(STORAGE_KEY, cachedDeviceId);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
};

export const clearDeviceId = () => {
  setDeviceId(null);
};
