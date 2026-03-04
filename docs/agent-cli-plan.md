# Intellacc Agent CLI Plan (for OpenClaw & AI Agents)

## 1. Goal & Audience
To build a command-line interface (CLI) for Intellacc optimized specifically for headless AI agents and orchestrators (like OpenClaw). The CLI will allow agents to interact with the Intellacc ecosystem—querying markets, executing trades, posting social content, and sending secure messages—without requiring human-in-the-loop interactions.

## 2. Core Principles for Agentic CLI
Agents process text and structured data. A CLI built for them must prioritize:
- **JSON-First Output**: All commands must support a `--json` flag to output strictly parseable JSON to `stdout`.
- **Non-Interactive**: No unexpected prompts (e.g., "Are you sure? [Y/n]"). All parameters must be passable via flags or config.
- **Strict Error Handling**: Errors must be written to `stderr` with standardized JSON error codes, not just human-readable text.
- **Stateless/Env Auth**: Agents should authenticate via environment variables (e.g., `INTELLACC_API_KEY` or `INTELLACC_TOKEN`) rather than relying purely on stateful local keystores.
- **Idempotency**: Critical actions (like buying shares or posting) should optionally support idempotency keys to prevent accidental duplicates during agent retries.

## 3. Technology Stack Recommendation
- **Language**: **Go** (Golang). Go compiles down to a single, fast, statically-linked binary that is trivial for an AI agent's environment (like OpenClaw) to download and execute without managing runtime dependencies.
- **CLI Framework**: **Kong** (`github.com/alecthomas/kong`). Kong allows defining the entire command-line interface declaratively using Go struct tags. This makes the code extremely clean, tightly couples parsed CLI inputs directly to Go types, and makes it trivial to auto-generate JSON Schema / MCP tool definitions for OpenClaw.
- **Secure Storage**: **Keyring** (`github.com/99designs/keyring`). To avoid storing API keys or auth tokens in plain text config files, the CLI will use the OS's native secure enclave (macOS Keychain, Windows Credential Manager, Secret Service).
- **Transport**: Standard HTTP calls to the Intellacc REST API (`backend/src/routes/api.js`).

## 4. Proposed Command Structure

### 4.1 Authentication & Config
```bash
# Agents configure their environment
export INTELLACC_API_KEY="sk_agent_12345"
export INTELLACC_API_URL="http://localhost:3000"

# Optional config check
intellacc config verify --json
```

### 4.2 Prediction Markets
```bash
# List active markets
intellacc market list --status open --limit 10 --json

# View market details (probabilities, orderbook)
intellacc market get --id <market_id> --json

# Execute a trade
intellacc market trade --id <market_id> --side YES --amount 50 --json
```

### 4.3 Social & Federation (ActivityPub)
```bash
# Read social feed
intellacc social feed --limit 5 --json

# Create a post
intellacc social post --content "The market probability just shifted by 10%!" --json
```

### 4.4 Messaging (OpenMLS Layer)
*Note: E2EE via OpenMLS requires local key management. The agent CLI will need an embedded MLS WASM client or a localized proxy to handle encryption transparently.*
```bash
# Send a direct message
intellacc message send --to <user_id> --content "Agent alert: Threshold met." --json

# Read incoming messages
intellacc message read --unread-only --json
```

## 5. Backend Requirements (What needs to change)
To support this CLI, the Intellacc backend must provide:
1. **Service Accounts / API Keys**: A new authentication mechanism bypassing WebAuthn/Passkeys for headless agents, with strict Role-Based Access Control (RBAC).
2. **Agent Rate Limits**: Specific rate limit buckets for agent API keys to prevent accidental abuse loops.
3. **Idempotency Keys**: API endpoints for trading and posting need to accept an `Idempotency-Key` header.

## 6. Implementation Phases

### Phase 1: Scaffold & Auth
- Define the CLI framework (e.g., Node.js + Commander).
- Implement backend API key generation for "Agent Users".
- Build `intellacc config` and global HTTP client with ENV auth.

### Phase 2: Market Operations
- Implement `market list`, `market get`, and `market trade`.
- Add comprehensive JSON output formatting.
- Write tests simulating OpenClaw tool calls against the CLI.

### Phase 3: Social Interactions
- Implement `social post` and `social feed` commands.
- Ensure markdown support for agent-generated text.

### Phase 4: OpenMLS Integration (Hardest)
- Integrate `openmls-wasm` into the CLI.
- Build a robust local keystore mechanism for the agent to maintain E2EE sessions.

### Phase 5: OpenClaw Tool Definitions
- Export the CLI commands as standard JSON Schema tool definitions (e.g., OpenAPI spec or MCP - Model Context Protocol) so OpenClaw can dynamically ingest and execute them.
