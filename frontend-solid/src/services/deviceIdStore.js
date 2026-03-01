let deviceId = null;
let pendingDeviceId = null;

export const getDeviceId = () => deviceId;

export const setDeviceId = (id) => {
  deviceId = id || null;
};

export const clearDeviceId = () => {
  deviceId = null;
};

export const getPendingDeviceId = () => pendingDeviceId;

export const setPendingDeviceId = (id) => {
  pendingDeviceId = id || null;
};

export const clearPendingDeviceId = () => {
  pendingDeviceId = null;
};
