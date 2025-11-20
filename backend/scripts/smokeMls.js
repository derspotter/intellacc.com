#!/usr/bin/env node
/**
 * Quick MLS API smoke test.
 *
 * Usage:
 *   node scripts/smokeMls.js --token <JWT> --conversation 1 --client web:dev
 *
 * By default the script targets http://localhost:3000. Override with --base-url.
 *
 * This does not validate responses beyond HTTP status codes; check the console output
 * and your Postgres tables (mls_key_packages, mls_commit_bundles, mls_messages) after running.
 */

const { Buffer } = require('buffer');

const args = process.argv.slice(2);
const options = {
  baseUrl: 'http://localhost:3000',
  token: null,
  conversation: null,
  client: null
};

for (let i = 0; i < args.length; i += 1) {
  const key = args[i];
  const value = args[i + 1];
  switch (key) {
    case '--base-url':
      options.baseUrl = value;
      i += 1;
      break;
    case '--token':
      options.token = value;
      i += 1;
      break;
    case '--conversation':
      options.conversation = Number(value);
      i += 1;
      break;
    case '--client':
      options.client = value;
      i += 1;
      break;
    default:
      break;
  }
}

if (!options.token) {
  console.error('Missing --token argument (JWT required).');
  process.exit(1);
}

if (!options.client) {
  console.error('Missing --client argument (MLS client identifier).');
  process.exit(1);
}

if (!Number.isInteger(options.conversation)) {
  console.error('Missing or invalid --conversation argument (numeric conversation id).');
  process.exit(1);
}

async function post(path, body) {
  const url = new URL(`/api${path}`, options.baseUrl).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  const output = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  console.log(`POST ${path} -> ${res.status}`);
  if (output) console.log(output);
  return res.status;
}

function randomBase64(bytes = 12) {
  return Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256))).toString('base64');
}

(async () => {
  try {
    const keyPackagePayload = {
      clientId: Buffer.from(options.client).toString('base64'),
      ciphersuite: 1,
      credentialType: 'basic',
      keyPackages: [randomBase64(64)]
    };
    await post('/mls/key-packages', keyPackagePayload);

    const commitPayload = {
      conversationId: options.conversation,
      senderClientId: options.client,
      bundle: randomBase64(80),
      welcome: randomBase64(32),
      groupInfo: randomBase64(32),
      encryptedMessage: randomBase64(48)
    };
    await post('/mls/commit', commitPayload);

    const messagePayload = {
      conversationId: options.conversation,
      senderClientId: options.client,
      epoch: 0,
      ciphertext: randomBase64(48)
    };
    await post('/mls/message', messagePayload);

    const historyPayload = {
      conversationId: options.conversation,
      senderClientId: options.client,
      data: randomBase64(32)
    };
    await post('/mls/history-secret', historyPayload);

    console.log('Done. Inspect the backend logs and MLS tables for persisted rows.');
  } catch (error) {
    console.error('MLS smoke test failed:', error);
    process.exit(1);
  }
})();
