# MLS WASM Concurrency Bug

## Problem

When logging in and using messaging, users encounter these errors:

```
[MLS] Error exporting state for vault: RuntimeError: unreachable executed
[MLS] Failed to ensure key packages: recursive use of an object detected which would lead to unsafe aliasing in rust
```

The "recursive use of an object" error is a Rust borrow checker issue surfacing in WASM - multiple async JavaScript operations are trying to access the same mutable Rust object simultaneously.

## Root Cause

The `CoreCryptoClient` in `frontend/src/services/mls/coreCryptoClient.js` has multiple async methods that access `this.client` (the WASM MLS client) concurrently:

1. **Login flow** triggers:
   - `setupKeystoreWithPassword()` → `exportStateForVault()` → accesses `this.client`
   - `ensureKeyPackagesFresh()` → accesses `this.client`

2. **These run in parallel** because they're both triggered during `onLoginSuccess()` without awaiting each other.

3. **WASM/Rust limitation**: The OpenMLS WASM client uses mutable borrows internally. When JS calls two methods "simultaneously" (before one completes), Rust's borrow checker panics.

## Affected Code Paths

- `frontend/src/services/auth.js` - `onLoginSuccess()` triggers vault setup
- `frontend/src/services/vaultService.js` - `setupKeystoreWithPassword()` calls `exportStateForVault()`
- `frontend/src/services/mls/coreCryptoClient.js`:
  - `ensureKeyPackagesFresh()` - generates key packages
  - `exportStateForVault()` - exports MLS state
  - `sendMessage()` - sends encrypted messages

## Solutions

### Option 1: Fix in OpenMLS WASM (Proper Fix)
Add interior mutability (`RefCell`, `Mutex`, or `RwLock`) in the Rust code to handle concurrent access safely. This requires modifying the `openmls-wasm` library.

### Option 2: Serialize Operations in JS (Workaround)
Add a mutex/lock in `CoreCryptoClient` to serialize all WASM client access:

```javascript
// In constructor
this._operationQueue = Promise.resolve();

// Wrapper method
async _withLock(operation) {
    const previous = this._operationQueue;
    let resolve;
    this._operationQueue = new Promise(r => resolve = r);
    try {
        await previous;
        return await operation();
    } finally {
        resolve();
    }
}

// Wrap critical methods
async ensureKeyPackagesFresh() {
    return this._withLock(async () => {
        // existing code
    });
}
```

### Option 3: Fix the Async Flow (Architectural)
Restructure `onLoginSuccess()` to properly sequence operations:

```javascript
// Instead of parallel operations, await each step
await vaultService.setupKeystoreWithPassword(password);
// Only after vault is set up, ensure key packages
await mlsClient.ensureKeyPackagesFresh();
```

## Recommendation

**Option 3** is the cleanest - fix the async flow so operations don't overlap. The login sequence should be:

1. Login API call
2. Setup vault/keystore (await)
3. Initialize MLS client (await)
4. Generate key packages (await)
5. Setup socket listeners

Each step should complete before the next begins.

## Files to Modify

1. `frontend/src/services/auth.js` - Fix `onLoginSuccess()` sequencing
2. `frontend/src/services/vaultService.js` - Ensure proper async/await
3. `frontend/src/services/mls/coreCryptoClient.js` - May need to expose better sequencing hooks

## Testing

After fix:
1. Clear browser storage
2. Run `./tests/e2e/reset-test-users.sh`
3. Login as `user1@example.com` / `password123`
4. Check console for MLS errors
5. Try sending a message to `user2@example.com`
