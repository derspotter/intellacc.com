// frontend/src/workers/keyWrapWorker.js
// Dedicated worker to wrap (encrypt) private key at rest

function strToBytes(str) {
  const enc = new TextEncoder();
  return enc.encode(str);
}
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

self.addEventListener('message', async (e) => {
  const { action, privateKeyBase64, passphrase } = e.data || {};
  if (action !== 'encryptAtRest') {
    self.postMessage({ error: 'unsupported action' });
    return;
  }
  try {
    // Derive key
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passKey = await crypto.subtle.importKey('raw', strToBytes(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      passKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    // Encrypt
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ptBytes = strToBytes(privateKeyBase64);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, ptBytes);

    // Zeroise plaintext bytes
    ptBytes.fill(0);

    self.postMessage({
      ok: true,
      record: {
        encryptedPrivateKey: bytesToBase64(new Uint8Array(ct)),
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
      }
    });
  } catch (err) {
    self.postMessage({ error: err?.message || String(err) });
  }
});
