# OpenMLS Persistence Strategy: Solving the Sync/Async Mismatch

## The Problem: Sync vs. Async

When integrating Rust-based WebAssembly (Wasm) modules like OpenMLS with browser APIs, a fundamental architectural mismatch occurs:

*   **Rust/Wasm (Synchronous):** The OpenMLS Rust crate defines storage traits (e.g., `OpenMlsStorage`) with synchronous function signatures. For example:
    ```rust
    fn read(&self, key: &[u8]) -> Option<Vec<u8>>;
    ```
    The Wasm runtime expects to call this function and receive the data *immediately* in the same tick of the execution.

*   **Browser/IndexedDB (Asynchronous):** The browser's persistent storage APIs, particularly IndexedDB, are purely asynchronous. They return `Promises` or use event callbacks.
    ```javascript
    const request = store.get(key); // Returns immediately, result comes later via onsuccess
    ```

**The Conflict:** Wasm cannot "pause" execution to wait for a JavaScript Promise to resolve. Attempting to force this synchronization would block the browser's main thread, freezing the UI, which modern browsers explicitly disallow.

## Implemented Solution (Dec 2025): High-Performance Granular Storage

To solve both the sync/async mismatch and the O(N) serialization bottleneck of the previous snapshot approach, we have implemented a **Granular Write-Behind** strategy, inspired by Wire's architecture.

### Architecture: The "Write-Behind" Pattern

1.  **In-Memory "Hot" Storage (Rust):**
    We created a custom `GranularStorage` struct in Rust that holds all OpenMLS entities (KeyPackages, Groups, PSKs, etc.) in granular `RwLock<HashMap>` structures. This allows OpenMLS to perform all read/write operations synchronously in O(1) time, satisfying the trait requirements without blocking.

2.  **Dirty Event Log (Write-Through):**
    Instead of serializing the entire state on every change, every write operation appends a `StorageEvent` to a `dirty_events` queue.
    ```rust
    struct StorageEvent {
        category: String, // e.g., "key_package", "group_state"
        key: String,      // Hex-encoded key
        value: Option<Vec<u8>>, // None = Delete, Some = Insert/Update
    }
    ```

3.  **Async Persistence Bridge (JS):**
    The JavaScript layer periodically (or after critical operations) calls `client.drain_storage_events()`. This atomic operation:
    *   Locks the dirty log.
    *   Drains all pending events.
    *   Returns them to JavaScript as a high-performance array.
    *   Clears the log in Rust.
    
    The JavaScript client then iterates over these events and processes them against IndexedDB asynchronously.

### Benefits

*   **Blazing Fast (O(1)):** Critical path cryptographic operations never block on I/O. They only update in-memory hashmaps and push a small struct to a vector.
*   **Granular:** Only changed items are persisted. If a single key is rotated, we don't re-serialize the entire 10MB group state.
*   **Zero-Copy Bridge:** We utilize `serde-wasm-bindgen` to transfer the event list directly to JavaScript with minimal serialization overhead.
*   **Compatibility:** Fully implements `StorageProvider<1>` for OpenMLS 0.7.1.

### Code Structure

*   **Rust (`openmls-wasm`):**
    *   `GranularStorage`: Core struct with `HashMap`s and `dirty_events`.
    *   `impl StorageProvider<1> for GranularStorage`: trait implementation.
    *   `MlsClient::drain_storage_events()`: Bridge method.
*   **JavaScript (`CoreCryptoClient.js`):**
    *   Needs to implement the `drain` loop: `let events = client.drain_storage_events(); db.batch(events);`

---

## Deprecated Solution: Snapshot Persistence

*Previous implementation kept for fallback/reference.*

To resolve this without rewriting the entire OpenMLS crate to be async (which is non-trivial), we implemented a **Snapshot Persistence** strategy.

### Core Concept
1.  **In-Memory Operation:** The Wasm module uses a fast, synchronous in-memory `HashMap` storage during runtime. This satisfies the Rust traits perfectly.
2.  **Async Snapshots:** Whenever a meaningful change occurs (e.g., creating a user, joining a group), we export the **entire** storage state from Wasm memory and save it as a "blob" to IndexedDB asynchronously.
3.  **Rehydration on Load:** On application startup, we fetch this blob from IndexedDB and inject it back into Wasm memory before any MLS operations begin.

### Implementation Details

We modified `frontend/src/services/mls/coreCryptoClient.js` to implement this strategy.

#### 1. Saving State (`saveState`)
We updated `saveState` to call `client.export_storage_state()`. This Rust function serializes the internal storage provider (keys, groups, epoch secrets) into a `Uint8Array`.

```javascript
// coreCryptoClient.js

async saveState() {
    // ... setup ...
    
    // 1. Snapshot the volatile Wasm memory
    const storageState = this.client.export_storage_state(); 

    // 2. Save snapshot alongside identity in IndexedDB
    await this.db.put({
        // ... (identity data)
        storageState: storageState, // The full vault blob
        // ...
    });
}
```

#### 2. Loading State (`loadState`)
We updated `loadState` to check for this blob and restore it.

```javascript
// coreCryptoClient.js

async loadState(username) {
    // ... fetch record from DB ...

    if (record.storageState) {
        // 1. Rehydrate the Wasm memory with previous state
        const storageBytes = new Uint8Array(record.storageState);
        this.client.import_storage_state(storageBytes);
    }
    
    // 2. Client is now ready to process messages for known groups
}
```

## Benefits
*   **Performance:** All cryptographic operations run at native Wasm speed without overhead from async JS calls for every read/write.
*   **Consistency:** The stored state is an atomic snapshot of a valid moment in time.
*   **Simplicity:** We avoid complex "Asyncify" workarounds or proxied storage adapters.

---

## Known Issue: Race Condition on Vault Restore (Dec 2025)

### The Bug

During E2EE testing, we discovered a **race condition** where group state is lost:

1. User B receives an invitation (Welcome message)
2. User B joins the group via `process_welcome()` → state is in WASM memory
3. `saveCurrentState()` is triggered to persist to vault (async)
4. **BUT** vault restore can occur before save completes (e.g., on page navigation)
5. The restore **overwrites** the new in-memory state with old vault data (0 groups)
6. Result: "Group not found" error when user tries to send messages

### Console Log Evidence

```
[LOG] [WASM] Imported storage state: 0 groups restored   ← Vault had no groups
[LOG] [MLS] State restored from vault for: 9
[LOG] [Vault] Unlocked for user: 9
[ERROR] [Messages] MLS send error: Group not found        ← Group was lost!
```

The Welcome WAS processed and the message WAS decrypted, but the group state wasn't saved before the vault restore occurred.

---

## Industry Research: How Others Solve This

### Wire's CoreCrypto (Production Solution)

[Wire's CoreCrypto](https://github.com/wireapp/core-crypto) has solved this problem with a production-grade implementation:

> *"On WebAssembly, the keystore calls into the browser's IndexedDB to persist data and AES256-GCM to encrypt data (via RustCrypto)."*
> — [CoreCrypto Architecture Docs](https://github.com/wireapp/core-crypto/blob/main/docs/ARCHITECTURE.md)

**Key Design:**
- Custom async IndexedDB keystore written in Rust
- Uses [wasm-bindgen-futures](https://crates.io/crates/wasm-bindgen-futures) to bridge JS Promises ↔ Rust Futures
- Encryption at rest with AES256-GCM
- Single "Central" object owns all runtime state

**Caveat from Wire:**
> *"The keystore's implementation of encryption at rest on WASM isn't validated nor audited so paper cuts expected."*

### Matrix Rust SDK IndexedDB Store (Production E2EE on Web, non-MLS)

The [Matrix Rust SDK](https://github.com/matrix-org/matrix-rust-sdk) ships a dedicated [`matrix-sdk-indexeddb`](https://github.com/matrix-org/matrix-rust-sdk/tree/main/crates/matrix-sdk-indexeddb) crate that implements an IndexedDB-backed storage layer for web. It exposes an `IndexeddbCryptoStore` for end-to-end encryption state and opens asynchronously, with optional passphrase-based encryption via a `StoreCipher` that encrypts store contents.

**Why it matters:** This is a production-grade Rust/WASM async crypto store in the browser (Matrix uses Olm/Megolm, not MLS), and it validates the IndexedDB + async Rust pattern at scale.

### Comparison: Existing Approaches

| Approach | MLS Compatible | Storage Model | Async/Sync | Encryption at Rest | Maturity | Primary Tradeoff |
|----------|----------------|---------------|------------|--------------------|----------|------------------|
| **Granular Write-Behind (NEW)** | Yes (OpenMLS) | Granular + Dirty Log | Sync Wasm / Async Persist | App-layer (vault) | Implemented | Requires JS persistence loop |
| **Snapshot Persistence** | Yes (OpenMLS) | Full in-memory + blob snapshots | Sync in Wasm, async snapshots | App-layer (vault) | Prototype | Race conditions + large blob writes |
| **Wire CoreCrypto** | Yes (OpenMLS) | Rust keystore + IndexedDB on WASM | Fully async in Rust | AES256-GCM (WASM) | Production | API refactor + GPL licensing |
| **Matrix Rust SDK IndexedDB** | No (Olm/Megolm) | Rust async store + IndexedDB | Fully async in Rust | StoreCipher (passphrase) | Production | Different protocol + integration effort |
| **Async OpenMLS StorageProvider (fork)** | Yes (OpenMLS) | IndexedDB/SQLite-WASM | Fully async in Rust | Your choice | Custom | High effort + maintenance |

### wasm-bindgen-futures

The [wasm-bindgen-futures](https://rustwasm.github.io/docs/wasm-bindgen/reference/js-promises-and-rust-futures.html) crate provides the bridge:

```rust
// Convert JS Promise to Rust Future
let future = JsFuture::from(js_promise);
let result = future.await?;

// Convert Rust Future to JS Promise
let promise = future_to_promise(async {
    // async Rust code
});
```

### The `idb` Crate

[idb](https://docs.rs/idb) is a futures-based crate for IndexedDB in Rust WASM:

```rust
// Async IndexedDB operations in Rust
let db = Factory::new()?.open("my_db", 1, ...)?;
let tx = db.transaction(&["store"], TransactionMode::ReadWrite)?;
let store = tx.object_store("store")?;
store.add(&value, &key).await?;
```

### OpenMLS SQLite Storage Provider (Jan 2025)

OpenMLS merged a [SQLite storage provider](https://github.com/openmls/openmls/actions/runs/13028754386) in January 2025. However, this targets native platforms, not WASM browsers.

### SQLite-WASM with OPFS

For browser persistence, [SQLite WASM](https://sqlite.org/wasm/doc/trunk/persistence.md) can use:
- **Origin-Private FileSystem (OPFS)** - best performance, requires SharedArrayBuffer
- **localStorage/sessionStorage** - limited size
- **IndexedDB via absurd-sql** - deprecated workaround

### Evaluation: SQLite WASM + OPFS in a Web Worker

**Upsides**
- Transactional storage with WAL and incremental writes (no full-blob snapshots).
- Lower latency than IndexedDB for write-heavy patterns, especially in workers.
- Runs off the main thread, so crypto and I/O do not block the UI.
- Structured schema + migrations enable versioned durability and recovery.

**Downsides / Risks**
- Browser support uneven (Safari/iOS requires fallback).
- Best performance often needs cross-origin isolation for SharedArrayBuffer/threads.
- No built-in encryption at rest; requires app-layer crypto or SQLCipher-like build.
- Multi-tab concurrency needs explicit locking/single-writer strategy.
- Higher integration complexity (worker bootstrapping, bundling, migrations).

**OpenMLS Fit**
- If OpenMLS runs inside the same worker and uses sync SQLite calls, Asyncify can be avoided.
- Still requires a dedicated storage adapter and schema for groups/epochs/key material.
- Fallback path still needed for non-OPFS browsers (IndexedDB or snapshot).

---

## Solution Options

| Option | Effort | Pros | Cons |
|--------|--------|------|------|
| **1. Fix Operation Order** | Low | Quick fix | Doesn't solve root cause |
| **2. Merge States** | Medium | Preserves both old + new | Complex merge logic |
| **3. Async StorageProvider** | High | Proper solution | Requires Rust changes |
| **4. Use Wire CoreCrypto** | High | Battle-tested | Major refactor |

### Option 1: Fix Operation Order (Recommended Short-term)

Process Welcome messages BEFORE restoring from vault:

```javascript
// In vaultService.unlock() or coreCryptoClient.restoreStateFromVault()

async restoreStateFromVault() {
    // 1. First, check for pending Welcome messages
    const pendingInvites = await this.fetchPendingWelcomes();

    // 2. Then restore vault state
    await this.importStorageState(vaultBlob);

    // 3. Finally, process Welcomes (they'll add to restored state)
    for (const invite of pendingInvites) {
        await this.joinGroup(invite.welcomeBytes);
    }

    // 4. Save merged state
    await this.saveCurrentState();
}
```

### Option 2: Merge States

Instead of overwriting, merge the vault state with current in-memory state:

```javascript
async restoreStateFromVault() {
    // Export current in-memory groups first
    const currentGroups = this.client.get_group_ids();

    // Import vault state
    await this.importStorageState(vaultBlob);

    // Re-add any groups that were in memory but not in vault
    // (This requires tracking group membership separately)
}
```

### Option 3: Async StorageProvider (Long-term)

Implement a custom `StorageProvider` in Rust that uses `idb` crate:

```rust
// openmls-wasm/src/storage.rs
use idb::{Database, Factory, TransactionMode};
use wasm_bindgen_futures::JsFuture;

pub struct IndexedDbStorage {
    db: Database,
}

impl StorageProvider for IndexedDbStorage {
    // Note: OpenMLS traits are sync, so this requires Asyncify or
    // pre-loading all data into memory before operations
}
```

**Challenge:** OpenMLS's `StorageProvider` trait is synchronous. Making it async requires either:
- Asyncify (2x binary size, 2-5x slower)
- Pre-loading all data into memory (our current approach)
- Forking OpenMLS to add async traits

### Option 4: Use Wire CoreCrypto

Wire's [core-crypto](https://github.com/wireapp/core-crypto) already solves this:

```javascript
import { CoreCrypto } from '@wireapp/core-crypto';

const cc = await CoreCrypto.init({
    databaseName: 'my_app_crypto',
    key: encryptionKey,
    clientId: 'user123'
});

// All MLS operations with built-in IndexedDB persistence
await cc.createConversation(groupId, config);
await cc.encryptMessage(groupId, plaintext);
```

**Pros:** Battle-tested, actively maintained, proper async storage
**Cons:** Different API, would require significant refactoring

---

## Recommendation

### Immediate (Dec 2025)
Implement **Option 1** to fix the race condition by ensuring Welcome processing happens AFTER vault restore, then save the merged state.

### Medium-term (Q1 2026)
Evaluate **Option 4** (Wire CoreCrypto) for a production-grade solution with proper async persistence.

### Long-term
Monitor OpenMLS for async `StorageProvider` support or WASM-specific persistence crates.

---

## References

- [Wire CoreCrypto](https://github.com/wireapp/core-crypto) - Production MLS implementation
- [wasm-bindgen-futures](https://crates.io/crates/wasm-bindgen-futures) - JS Promise ↔ Rust Future bridge
- [idb crate](https://docs.rs/idb) - Async IndexedDB for Rust WASM
- [Matrix Rust SDK](https://github.com/matrix-org/matrix-rust-sdk) - Production E2EE stack (Olm/Megolm)
- [matrix-sdk-indexeddb](https://github.com/matrix-org/matrix-rust-sdk/tree/main/crates/matrix-sdk-indexeddb) - IndexedDB-backed crypto store for web
- [OpenMLS StorageProvider](https://book.openmls.tech/traits/traits.html) - Trait documentation
- [OpenMLS Persistence](https://book.openmls.tech/user_manual/persistence.html) - Group state persistence
- [SQLite WASM Persistence](https://sqlite.org/wasm/doc/trunk/persistence.md) - Browser storage options

---

## Strategic Analysis: The Ideal Long-Term Architecture

While **Option 4 (Wire CoreCrypto)** is a valid "buy" decision, if we want to maintain our own stack, there is a superior architectural pattern that solves the sync/async mismatch natively without the complexity of Asyncify or limited snapshots.

### Recommendation: SQLite WASM + OPFS in a Web Worker

The most robust long-term solution (2025/2026 era) is to move the OpenMLS client into a **Web Worker** and use **SQLite WASM** with the **Origin Private File System (OPFS)** backend.

#### Why this works
1.  **Synchronous VFS**: SQLite WASM provides a synchronous Virtual File System (VFS) interface when running in a Web Worker. It uses `Atomics.wait` and `SharedArrayBuffer` to block the worker thread while the browser performs the underlying I/O.
2.  **Native OpenMLS Compatibility**: Because the storage interface appears synchronous to the Rust code, we can use the standard, unmodified OpenMLS synchronous traits.
3.  **No Main Thread Blocking**: The "blocking" happens in the background Worker thread, leaving the UI thread completely free.
4.  **Crash Safety**: SQLite handles atomicity and data integrity, preventing the "partial write" or "race condition" issues we see with manual blob snapshots.

#### Architecture Diagram

```mermaid
graph TD
    UI[Main Thread (UI)] -- postMessage --> Worker[Web Worker]
    
    subgraph Worker Context
        MLS[OpenMLS (Rust/Wasm)]
        SQL[SQLite Storage Provider (Rust)]
        SQW[SQLite WASM (C/Wasm)]
    end
    
    SQW -- Sync VFS (Atomics) --> OPFS[Browser OPFS Storage]
```

#### Implementation Path
1.  **Rust Layer**: Replace `openmls_memory_storage` with a generic `rusqlite` or `diesel` implementation (OpenMLS released a `sqlite` provider recently).
2.  **Wasm Layer**: Compile with `sqlite-wasm` bindings.
3.  **JS Layer**: Instantiate the generic `OpenMLS` worker.

**Verdict**: This is technically superior to "Asyncify" (which adds overhead) or "Wire CoreCrypto" (which is a black box). It leverages standard browser capabilities (Workers + OPFS) to align the runtime model with OpenMLS's synchronous requirements.
