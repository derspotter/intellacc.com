#!/usr/bin/env node
// Register lifecycle hooks if available. Placeholder until we have server-side CoreCrypto or IPC.

const { registerLifecycleHooks } = require('../src/services/mlsLifecycleService');

registerLifecycleHooks({});
