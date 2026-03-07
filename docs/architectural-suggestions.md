# Architectural Suggestions for Intellacc (ALL ITEMS RESOLVED)

Based on a survey of the Intellacc application architecture, the following observations and suggestions for improvement have been identified and executed.

## 🏗️ Architectural Overview
The system follows a microservices-style split to handle different concerns optimally:
*   **Social & API Gateway (Node.js / Express):** Manages user authentication, social features, E2EE messaging (via MLS), and acts as a gateway for market operations. It heavily utilizes Socket.io for real-time market probability updates and notifications.
*   **Prediction Engine (Rust / Axum):** Offloads heavy mathematical operations. It is responsible for the Logarithmic Market Scoring Rule (LMSR) calculations, trading logic, and ledger-consistent market state transitions.
*   **Database (PostgreSQL):** Uses a micro-unit reputation ledger system to ensure strict consistency for available and staked RP, preventing floating-point drift and ensuring transactional integrity.
*   **Frontend Architecture (SolidJS):** The application is now fully unified on SolidJS (`frontend-solid`), replacing the legacy VanJS implementation. This provides high performance, signal-based reactivity, and improved maintainability.
*   **Secure Messaging (OpenMLS WASM):** Employs Messaging Layer Security (MLS) compiled to WebAssembly for end-to-end encrypted private communications.

## 💡 Suggestions for Improvement & Tech Debt Reduction

### 1. Unified SolidJS Architecture (COMPLETED)
*   **Observation:** The application has successfully transitioned from VanJS to SolidJS (`frontend-solid`). This shift provides a more robust, signal-based reactive model and improves developer productivity.
*   **Recommendation:** With the primary switch complete, ensure all new features are implemented exclusively in the SolidJS codebase. The legacy `frontend` directory should be fully decommissioned to simplify the build process and eliminate technical debt.

### 2. Direct Rust Engine Access for Real-time Data (COMPLETED)
*   **Observation:** The Node.js backend currently acts as a proxy for many market calls and data streams originating from the Rust engine. This adds unnecessary latency and complicates error handling.
*   **Implementation:** The Rust prediction engine has been updated to directly validate JWTs (using the shared `JWT_SECRET`) alongside service-to-service tokens. Direct read endpoints (e.g., `GET /events`) have been added, and the CLI (`intellacc`) has been reconfigured to route market operations directly to the high-performance Rust service.
*   **Recommendation:** Expand this direct-access pattern to the SolidJS frontend, allowing it to fetch real-time market price streams or public ledger states straight from port 3001.

### 3. Formalize Inter-Service API Contracts (COMPLETED)
*   **Observation:** Communication between the Node.js API and the Rust prediction engine appears to rely on implicit JSON structures.
*   **Implementation:** The `ts-rs` crate has been added to the Rust prediction engine. Core LMSR structs (`MarketEvent`, `MarketUpdate`, outcome market payloads, etc.) now derive `TS`, automatically generating single-source-of-truth TypeScript definitions in the `shared/types/` directory upon testing. This ensures strict type safety between the Rust backend and the TS/JS consumers (Node.js & SolidJS) and prevents silent contract breaking changes during deployments.

### 4. Enhanced Ledger Auditing & Reconciliation (COMPLETED)
*   **Observation:** There is a robust SQL-based ledger audit system (`run_ledger_audit`), which is excellent for catching discrepancies within the database.
*   **Implementation:** An automated reconciliation worker was created (`LedgerAuditService`) that executes the SQL audit and recursively queries the Rust engine's `/lmsr/verify-consistency` and `/lmsr/verify-balance-invariant` endpoints. This ensures absolute mathematical consistency between the Node.js user ledgers and the Rust engine's LMSR core. A database trigger was also implemented to guarantee `cumulative_stake` (LMSR Cost) is correctly calculated upon market creation to prevent drift.

### 5. Distributed Tracing and Logging (SKIPPED)
*   **Observation:** Debugging user actions that span across the frontend, Node.js proxy, and Rust engine can be difficult without a unified view.
*   **Status:** Reviewed and deemed overkill for the current architectural scale. This will be deferred until cross-service debugging or latency tracking becomes a tangible operational bottleneck.

### 6. Streamline WASM Dependencies (COMPLETED)
*   **Observation:** The E2EE relies on WASM artifacts from `openmls-wasm`. Managing WASM binaries across environments can be tricky and lead to duplication.
*   **Implementation:** The OpenMLS WebAssembly artifacts have been successfully extracted into a central `shared/openmls-pkg` directory, eliminating the dependency between the new SolidJS frontend and the deprecated legacy frontend. Additionally, the SolidJS `vite.config.js` was upgraded to utilize `vite-plugin-compression` (enabling Brotli and Gzip for `.wasm` files) and manual chunking (`openmls-wasm` chunk). This strictly de-duplicates the payload and drastically reduces the initial network transfer size for the E2EE client.
