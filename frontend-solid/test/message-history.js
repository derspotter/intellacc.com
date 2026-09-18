import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import vault from '/src/services/mls/vaultService.js';
import vaultStore from '/src/store/vaultStore.js';
import core from '@shared/mls/coreCryptoClient.js';
import { createMessageHistory } from '/src/services/mls/messageHistory.js';
import { ChatPanel } from '/src/components/ChatPanel.jsx';
import MessagesPage from '/src/pages/MessagesPage.jsx';
import initMls, { MlsClient } from '@openmls';
import '/src/index.css';
import '/src/styles.css';

let key;
let history;
let state;
let unmount;
let gate;
let release;
let nextSentId = 9000;
let receiverIdentity;
let stats = { decrypts: 0, active: 0, peak: 0 };
const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
crypto.subtle.decrypt = async (...args) => {
  stats.decrypts++;
  stats.active++;
  stats.peak = Math.max(stats.peak, stats.active);
  try {
    if (gate) await gate;
    return await decrypt(...args);
  } finally { stats.active--; }
};
const getAll = IDBIndex.prototype.getAll;
IDBIndex.prototype.getAll = function (...args) {
  if (this.objectStore.name === 'encrypted_messages') throw new Error('Unbounded history scan');
  return getAll.apply(this, args);
};

const message = (id, overrides = {}) => ({
  id, groupId: 'chat-a', senderId: '42', type: 'application',
  plaintext: `Message ${id}`, timestamp: new Date(1700000000000 + Math.floor(id / 3)).toISOString(),
  ...overrides
});

window.historyFixture = {
  vault,
  core,
  async prepareMlsReceive() {
    await initMls();
    const sender = new MlsClient();
    const receiver = new MlsClient();
    sender.create_identity('43');
    receiver.create_identity('42');
    const groupId = 'dm_42_43';
    const groupBytes = new TextEncoder().encode(groupId);
    sender.create_group(groupBytes);
    receiverIdentity = [receiver.get_credential_bytes(), receiver.get_key_package_bundle_bytes(), receiver.get_signature_keypair_bytes()];
    const [welcome] = sender.add_member(groupBytes, receiver.get_key_package_bytes());
    sender.merge_pending_commit(groupBytes);
    receiver.process_welcome(welcome);
    await vault.persistGranularEvents(receiver.drain_storage_events());
    core.client = receiver;
    core.identityName = '42';
    const epoch = Number(sender.get_group_epoch(groupBytes));
    sender.set_group_aad(groupBytes, core.encodeAad(core.buildAadPayload(groupId, epoch, 'application')));
    const data = sender.encrypt_message(groupBytes, new TextEncoder().encode('Real MLS retry'));
    sender.free();
    return { id: '8100', group_id: groupId, data, content_type: 'application', sender_id: 'remote', sender_user_id: '43' };
  },
  async restoreMlsReceiver() {
    const receiver = new MlsClient();
    receiver.restore_identity(...receiverIdentity);
    receiver.import_granular_events(await vault.loadGranularEvents());
    core.client = receiver;
    core.identityName = '42';
  },
  async seed({ count = 125, legacy = true } = {}) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    if (legacy) {
      const records = [];
      for (let id = 1; id <= count + 2; id++) {
        const row = message(id);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
          new TextEncoder().encode(JSON.stringify({ plaintext: row.plaintext, senderId: row.senderId, type: row.type })));
        records.push({
          messageId: id, timestamp: row.timestamp,
          deviceId: id === count + 1 ? 'other-device' : 'fixture-device',
          groupId: id === count + 2 ? 'chat-b' : row.groupId,
          encryptedData: { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(data)) }
        });
      }
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('intellacc_keystore', 11);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('encrypted_messages', { keyPath: 'id', autoIncrement: true });
          for (const name of ['groupId', 'deviceId', 'timestamp']) store.createIndex(name, name);
          for (const record of records) store.add(record);
        };
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = () => reject(request.error);
      });
    }
    vault.setDeviceId('fixture-device');
    vault.compositeKey = key;
    vaultStore.setLocked(false);
    await vault.initDB();
    if (!legacy) for (let id = 1; id <= count; id++) await vault.persistMessage(message(id));
    return vault.db.version;
  },
  async open(group = 'chat-a') {
    history = createMessageHistory(vault, {
      onChange: (next) => { state = next; },
      onError: (error) => { window.historyError = error.message; }
    });
    await history.select(group);
  },
  select: (group) => history.select(group),
  older: () => history.loadOlder(),
  idle: () => history.idle(),
  state: () => state,
  stats: () => ({ ...stats }),
  resetStats: () => { stats = { decrypts: 0, active: 0, peak: 0 }; },
  async insert(id, overrides) { await vault.persistMessage(message(id, overrides)); await history?.idle(); },
  async edit(id, text, group = 'chat-a') { const result = await vault.applyMessageEdit(group, id, text, { requireSenderId: '42' }); await history?.idle(); return result; },
  async remove(id) { await vault.markMessageDeleted('chat-a', id, { requireSenderId: '42' }); await history?.idle(); },
  pause() { gate = new Promise((resolve) => { release = resolve; }); },
  resume() { gate = null; release?.(); },
  lock: () => vault.lockKeys(),
  unlock() { vault.setDeviceId('fixture-device'); vault.compositeKey = key; vaultStore.setLocked(false); },
  dispose: () => history?.dispose(),
  mount(skin) {
    core.client = {};
    core.identityName = '42';
    core.ensureMlsBootstrap = async () => {};
    core.syncMessages = async () => {};
    core.listGroupChats = async () => [];
    core.getDisappearingTimer = async () => 0;
    core.sendReadReceipt = async () => {};
    core.getContactVerificationStatus = async () => null;
    core.sendMessage = async (groupId, plaintext) => {
      const id = nextSentId++;
      await vault.persistMessage(message(id, { groupId, plaintext, timestamp: new Date().toISOString() }));
      return { id };
    };
    unmount = render(() => createComponent(skin === 'terminal' ? ChatPanel : MessagesPage, {}), document.getElementById('fixture'));
  },
  unmount: () => unmount?.()
};
