# Intellacc Development Guide

## Project Overview
Intellacc is a prediction and social platform where users can:
- Create events for others to predict on
- Make predictions on events with confidence levels
- Post and comment in a social feed
- Follow other users and track prediction accuracy
- Place bets on assigned predictions
- Admin features for event management
- **LMSR Market System**: Full automated market making with real-time probability updates

## Architecture
- **Frontend**: VanJS-based SPA with Vite dev server (port 5173)
- **Backend**: Express.js API with Socket.io for real-time features (port 3000)
- **Database**: PostgreSQL with direct SQL queries
- **Prediction Engine**: Rust-based service (port 3001) - LMSR market maker
- **Reverse Proxy**: Caddy for production (ports 80/443)

**IMPORTANT**: This is a Docker-based project. All npm commands, file operations, and development must be run inside the respective Docker containers, not on the host system.

## Quick Start (Docker - Recommended)
```bash
# Create network (run once)
docker network create intellacc-network

# Start full stack including prediction engine
docker compose up -d

# Access the application
# Frontend: http://localhost:5173
# Backend API: http://localhost:3000/api
# Prediction Engine: http://localhost:3001/health
# Health check: http://localhost:3000/api/health-check

# Stop services
docker compose down
```

## Recent Features Added

### LMSR Security & Reliability Hardening (Latest - July 2025)
- **Production-Grade Security**: Comprehensive security audit and hardening completed
- **DoS Protection**: Replaced all panic!() calls with Result returns to prevent denial of service attacks
- **Input Validation**: API-level validation prevents invalid data from reaching core functions
- **Concurrency Safety**: SERIALIZABLE transaction isolation with exponential backoff retry logic
- **PostgreSQL SQLSTATE Integration**: Reliable error detection using proper error codes instead of fragile string matching
- **Numerical Stability**: Overflow protection and validated calculations for all market operations
- **Performance Optimization**: Exponential calculations verified as production-ready (sub-microsecond performance)
- **f64+i128 Precision System**: High-precision monetary calculations with 6-decimal RP precision
- **Side Enum Pattern**: Unified YES/NO trade logic with type-safe operations
- **Clean Database Adapter**: Eliminates scattered conversion code throughout the system

### LMSR Market System with Real-Time Updates (Previous - July 2025)
- **Complete Market Probability Updates**: Both buying AND selling shares now correctly update market probability
- **Fixed Prediction Engine**: Rust `sell_shares` function now recalculates market probability using proper LMSR economics
- **Real-Time WebSocket Broadcasts**: All market operations (buy/sell) trigger instant probability updates across all connected users
- **SellResult API Enhancement**: Sell operations return new market probability and cumulative stake for proper broadcasting
- **Market Economic Logic**: 
  - Selling YES shares decreases probability
  - Selling NO shares increases probability
  - Market state consistency maintained in database
- **Backend WebSocket Integration**: Streamlined broadcasts using new_prob field directly from prediction engine
- **Complete Test Coverage**: Comprehensive WebSocket testing scripts for both buy and sell operations

### Market Withdrawal System (Previous)
- **Complete Withdrawal Interface**: Users can now exit market positions with three options:
  - Sell All YES shares (individual button with share count)
  - Sell All NO shares (individual button with share count) 
  - Exit All Positions (complete liquidation button)
- **Confirmation Dialogs**: Native browser confirmation with detailed transaction info:
  - Estimated payout calculations based on current market prices
  - Share quantities and market price percentages
  - Warning messages for irreversible actions
- **Responsive Design**: Mobile-optimized withdrawal buttons with proper spacing
- **Real-time Updates**: Position data refreshes automatically after withdrawal
- **Error Handling**: Comprehensive error handling with user-friendly messages

### Kelly Criterion System Improvements (Previous)
- **Enhanced Reactivity**: Fixed VanJS reactivity issues with proper object spreading pattern
- **Belief Probability Slider**: Interactive slider showing real-time market edge calculation
- **Debounced API Calls**: Performance-optimized Kelly suggestions with 300ms debounce
- **Application Buttons**: One-click Kelly stake application (1/4 Kelly and Full Kelly)
- **Direct Input Elements**: Replaced TextInput component with native input for better state management
- **Comprehensive Display**: Formatted Kelly statistics with edge calculations and balance info

## Development Workflow Best Practices

### Screen Management
1. NEVER say a problem is solved/fixed/working before you explicitly say so
2. Screenshots location: 
    - `/home/jayjag/Nextcloud/intellacc.com/screenshots/`
    - Take screenshot: `mcp__browsertools__takeScreenshot`
    - Find latest: LS tool on screenshots directory
    - Look at it: Read tool on the latest screenshot file
    - Must ALWAYS both take AND examine screenshots

## VanJS Development Notes
- Never remove an element by returning null if we want to recreate it later in vanjs

## WebSocket Real-Time Updates Testing
**Test Scripts Available**:
- `/test/websocket-curl-test.sh` - Tests market updates via API calls
- `/test/websocket-sell-test.sh` - Tests sell operations and probability updates
- `/test/websocket-browser-test.html` - Browser-based real-time testing

**Expected WebSocket Behavior**:
- Market updates broadcast to all connected users
- Probability changes appear instantly without page refresh
- Both buy and sell operations trigger real-time updates
- Console logging: '📈 Market update received' for debugging

## Test Credentials
- Test User: user1@example.com (password: password123)
- Admin User: admin@example.com (password: adminpass)

## Database Access Commands
**IMPORTANT**: Database access commands for development and debugging:

```bash
# Basic database access
docker exec intellacc_db psql -U intellacc_user -d intellaccdb

# Run single queries
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT * FROM users;"

# Show table structure
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "\d table_name;"

# Common queries
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT COUNT(*) FROM predictions;"
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT COUNT(*) FROM events;"
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT id, username, role FROM users;"
```

**Database Credentials** (from /backend/.env):
- User: `intellacc_user`
- Password: `supersecretpassword`
- Database: `intellaccdb`
- Host: `db` (within Docker network) or `localhost:5432` (from host)

## LMSR Market System Implementation

### Core Components
- **Prediction Engine** (`/prediction-engine/src/lmsr_core.rs`): Production-grade LMSR implementation with security hardening
- **API Layer** (`/prediction-engine/src/lmsr_api.rs`): SERIALIZABLE transactions with PostgreSQL SQLSTATE error handling
- **Database Adapter** (`/prediction-engine/src/db_adapter.rs`): Clean f64/Decimal conversion layer
- **Backend Proxy** (`/backend/src/routes/api.js`): WebSocket broadcasting and API proxying
- **Frontend Components** (`/frontend/src/components/predictions/EventCard.js`): Real-time market interface

### Key Functions
- **`update_market()`**: Secure market updates with input validation and SERIALIZABLE transactions
- **`sell_shares()`**: Secure share selling with hold period checks and numerical stability
- **`kelly_suggestion()`**: Conservative Kelly criterion betting suggestions (25% Kelly factor)
- **`resolve_event()`**: Event resolution with proper payout distribution and stake unwinding

### Market Economics & Security
- **LMSR Formula**: Logarithmic Market Scoring Rule with liquidity parameter b=5000
- **f64+i128 Precision**: Core mathematics in f64 with 6-decimal fixed-point ledger (1,000,000 micro-RP units)
- **Overflow Protection**: `MAX_STAKE_TO_LIQUIDITY_RATIO = 700.0` prevents dangerous exponential calculations
- **Share Calculation**: YES shares = stake/prob, NO shares = stake/(1-prob) with Result error handling
- **Side Enum Safety**: Type-safe YES/NO operations replace brittle string matching
- **Payout Logic**: Market probability determines share value with numerical stability checks

### WebSocket Integration & Testing
- **Real-Time Broadcasts**: All market operations trigger `marketUpdate` events with security validation
- **Event Structure**: `{eventId, market_prob, cumulative_stake, action, user_id, timestamp}`
- **Frontend Reactivity**: VanJS reactive state updates position values automatically
- **Security Testing**: Comprehensive test scripts verify input validation and error handling:
  - `/test/test-api-validation.sh` - Tests invalid input rejection
  - `/test/test-concurrency-behavior.sh` - Tests SERIALIZABLE transaction behavior
  - `/test/load-test-exponentials.sh` - Performance testing under concurrent load
  - `/test/bench-exponentials.py` - Mathematical performance benchmarking

## VanJS Idiomatic Patterns & Best Practices

### Core Principles
- **Simplicity**: Minimal boilerplate, functional composition
- **Reactivity**: State-driven UI updates with `van.state()`
- **Composability**: Components as functions returning DOM elements
- **Performance**: Stateful binding and selective re-rendering

### Market Update Patterns (LMSR-Specific)
```javascript
// ✅ Correct: Reactive market state for real-time updates
const marketState = van.state({
  market_prob: 0.5,
  cumulative_stake: 0,
  unique_traders: 0
});

// ✅ Correct: WebSocket listener for market updates
const unregisterSocketHandler = registerSocketEventHandler('marketUpdate', (data) => {
  if (data.eventId === event.id) {
    marketState.val = {
      ...marketState.val,
      market_prob: data.market_prob,
      cumulative_stake: data.cumulative_stake
    };
  }
});

// ✅ Correct: Position value recalculation on price changes
van.derive(() => {
  const position = userPosition.val;
  const market = marketState.val;
  return {
    ...position,
    current_value: (position.yes_shares * market.market_prob) + 
                   (position.no_shares * (1 - market.market_prob))
  };
});
```

### State Management
```javascript
// ✅ Correct: Use van.state() for reactive state
const count = van.state(0)
const name = van.state('John')

// ✅ Correct: Update state values directly
count.val = count.val + 1
name.val = 'Jane'

// ❌ Wrong: Never mutate state objects directly
// const user = van.state({name: 'John'})
// user.val.name = 'Jane' // This prevents DOM updates!

// ✅ Correct: Replace entire object for nested state
const user = van.state({name: 'John'})
user.val = {...user.val, name: 'Jane'}
```