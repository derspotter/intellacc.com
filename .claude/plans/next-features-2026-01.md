# Intellacc Next Features Implementation Plan
## January 2026

Synthesized from surveys by Claude, Gemini, and Codex.

---

## Priority 1: Safety Numbers / Trust Layer (BLOCKING)

**Status**: WASM implemented, NO UI for verification
**Impact**: Critical for security - blocks platform launch

### What Exists
- `coreCryptoClient.getIdentityFingerprint()` - returns user's fingerprint
- `SafetyNumbers.js` - basic modal showing own fingerprint
- `SafetyNumbersButton` - rendered in Messages.js header

### What's Missing
- TOFU (Trust on First Use) persistence in IndexedDB
- Warning when fingerprint changes (potential MITM)
- Per-contact verification status storage
- "Verified" badge/icon in conversation list
- Fingerprint comparison UI for two users
- `inspect_staged_welcome()` / `inspect_staged_commit()` validation

### Files to Modify
- `frontend/src/services/mls/coreCryptoClient.js` - add `verifyContact()`, `getContactFingerprint()`
- `frontend/src/components/SafetyNumbers.js` - add comparison UI, verification flow
- `frontend/src/pages/Messages.js` - show verification status per conversation
- `frontend/src/services/vaultService.js` - persist verification state

### Implementation Steps
1. Add IndexedDB schema for verified contacts: `{userId, fingerprint, verifiedAt}`
2. Create `verifyContact(userId, fingerprint)` method
3. Add fingerprint comparison modal (side-by-side view)
4. Show warning toast when fingerprint changes
5. Add "Verified" checkmark to conversation list items
6. Wire `inspect_staged_welcome()` before accepting group invites

---

## Priority 2: Trade History + Event Selection

**Status**: Mock data only, no event selection state
**Impact**: Core market transparency and UX

### What Exists
- `market_updates` table with trade history
- `MarketStakes.js` component (read-only stats)
- Socket `marketUpdate` events working

### What's Missing
- `/events/:id/trades` endpoint returning recent trades
- `selectedEventId` global state
- Click-to-select in EventsList → MarketStakes
- Portfolio → Event navigation

### Files to Modify
- `prediction-engine/src/lmsr_api.rs` or `backend/src/routes/api.js` - add trades endpoint
- `frontend/src/store/predictions.js` - add `selectedEventId` state
- `frontend/src/components/predictions/EventsList.js` - set selection on click
- `frontend/src/components/predictions/MarketStakes.js` - fetch real trades
- `frontend/src/components/portfolio/UserPortfolio.js` - navigate to event

### Implementation Steps
1. Add `GET /events/:id/trades` endpoint (return last 50 trades)
2. Add `selectedEventId` to predictions store
3. Wire EventsList click → set selectedEventId
4. Update MarketStakes to fetch from real endpoint
5. Add "View Market" button in portfolio positions

---

## Priority 3: File Attachments

**Status**: Stub controller, no implementation
**Impact**: Rich content creation

### What Exists
- `attachmentsController.js` with TODO stubs
- `PostItem.js` renders `image_url` if present
- No upload UI

### What's Missing
- S3/GCS/local presigned URL generation
- Upload UI in CreatePostForm
- File metadata table
- Progress indicator
- E2EE attachments for messages (optional)

### Files to Modify
- `backend/src/controllers/attachmentsController.js` - implement presigned URLs
- `backend/migrations/` - add attachments metadata table
- `frontend/src/components/posts/CreatePostForm.js` - add file input
- `frontend/src/components/posts/PostItem.js` - render attachments

### Implementation Steps
1. Choose storage backend (S3/GCS/local MinIO)
2. Implement `presignUpload()` with real cloud SDK
3. Create migration for attachments table
4. Add file input + preview to CreatePostForm
5. Upload file, get URL, include in post creation
6. Display in PostItem

---

## Priority 4: Admin Authentication Guards

**Status**: TODO in code, no implementation
**Impact**: Ops safety

### What Exists
- `isAdminState` in frontend auth
- Admin role in users table
- No backend middleware

### What's Missing
- `isAdmin` middleware for backend
- Gating on weekly assignment trigger
- Admin-only routes protection

### Files to Modify
- `backend/src/middleware/adminAuth.js` - new file
- `backend/src/controllers/weeklyAssignmentController.js` - add guard
- `backend/src/routes/api.js` - apply middleware to admin routes

### Implementation Steps
1. Create `adminAuth.js` middleware checking `req.user.role === 'admin'`
2. Apply to weekly assignment endpoint
3. Apply to any future admin endpoints

---

## Priority 5: PWA / Offline Foundation

**Status**: Push-only service worker, no manifest
**Impact**: Mobile growth, offline capability

### What Exists
- `frontend/public/sw.js` - push notifications only
- Push subscription working
- No manifest.json
- No offline caching

### What's Missing
- `manifest.json` with app metadata
- Cache-first strategy for static assets
- Offline fallback page
- Install prompt UI

### Files to Modify
- `frontend/public/manifest.json` - new file
- `frontend/public/sw.js` - add caching strategies
- `frontend/index.html` - link manifest
- `frontend/src/main.js` - handle install prompt

### Implementation Steps
1. Create manifest.json with app name, icons, colors
2. Add static asset caching to sw.js
3. Create offline.html fallback
4. Add install prompt banner component
5. Test on mobile Chrome/Safari

---

## Priority 6: MLS Key Rotation (selfUpdate)

**Status**: WASM implemented, not called from frontend
**Impact**: Post-compromise security

### What Exists
- `coreCryptoClient.selfUpdate(groupId)` method
- `self_update()` in WASM

### What's Missing
- Automatic periodic rotation
- Manual "Refresh Keys" button in settings
- Visual indicator when rotation happens

### Files to Modify
- `frontend/src/services/mls/coreCryptoClient.js` - add periodic selfUpdate
- `frontend/src/components/settings/SettingsPage.js` - add security section
- `frontend/src/services/idleLock.js` - trigger on activity resume

### Implementation Steps
1. Add `performPeriodicKeyRotation()` function
2. Call on app resume / every 24 hours
3. Add "Refresh Encryption Keys" button in settings
4. Show toast when rotation completes

---

## Implementation Order

```
Week 1: Safety Numbers / Trust Layer
Week 2: Trade History + Event Selection
Week 3: File Attachments
Week 4: Admin Guards + PWA Foundation
Week 5: MLS Key Rotation + Polish
```

---

## Test Coverage Required

- E2E: Safety number verification flow
- E2E: Trade history display
- Unit: Attachment upload/download
- Unit: Admin middleware
- Manual: PWA install on mobile
- E2E: Key rotation doesn't break messaging

---

## Success Criteria

1. Users can verify contact fingerprints before trusting
2. Market activity is transparent with trade history
3. Posts can include images/files
4. Admin functions are protected
5. App installable as PWA
6. Keys rotate automatically for forward secrecy
