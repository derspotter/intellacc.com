let pendingDeviceId = null;

export const getPendingDeviceId = () => {
  if (!pendingDeviceId) {
    try { pendingDeviceId = sessionStorage.getItem('pending_device_id') || null; } catch {}
  }
  return pendingDeviceId;
};

export const setPendingDeviceId = (id) => {
  pendingDeviceId = id || null;
  try {
    if (id) sessionStorage.setItem('pending_device_id', id);
    else sessionStorage.removeItem('pending_device_id');
  } catch {}
};

export const clearPendingDeviceId = () => {
  pendingDeviceId = null;
  try { sessionStorage.removeItem('pending_device_id'); } catch {}
};
