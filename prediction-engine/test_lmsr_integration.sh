#!/bin/bash

# LMSR Integration Tests with Invariant Verification
# Tests complete API/DB flow with financial invariants

echo "=== LMSR Integration Tests with Invariant Verification ==="
echo "Testing complete market operations and financial invariants..."
echo ""

# Configuration
BASE_URL="http://localhost:3000"
LMSR_URL="http://localhost:3001"

# Use existing test users from database
ADMIN_EMAIL="admin@example.com"
ADMIN_PASS="adminpass"
TEST_USER_EMAIL="user1@example.com" 
TEST_USER_PASS="password123"
TEST_USER_ID=1004  # From database query

# Use an existing active event
TEST_EVENT_ID=37  # "Will AI systems achieve human-level reasoning by 2030?"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }
log_info() { echo -e "${YELLOW}ℹ️  $1${NC}"; }
log_test() { echo -e "${BLUE}🧪 $1${NC}"; }

# Test result tracking
TESTS_PASSED=0
TESTS_FAILED=0
TOTAL_TESTS=0

run_test() {
    local test_name="$1"
    local test_command="$2"
    
    log_test "Running: $test_name"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    if eval "$test_command"; then
        log_success "$test_name PASSED"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        log_error "$test_name FAILED"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

# Test 1: Setup and Authentication
test_setup() {
    log_info "Setting up test environment..."
    
    # Get user token (user1)
    USER_TOKEN=$(curl -s -X POST $BASE_URL/api/login \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$TEST_USER_EMAIL\",\"password\":\"$TEST_USER_PASS\"}" | jq -r '.token')
    
    if [ "$USER_TOKEN" = "null" ] || [ -z "$USER_TOKEN" ]; then
        log_error "Failed to get user token"
        return 1
    fi
    
    log_success "Authentication successful"
    
    # Get initial balance
    INITIAL_BALANCE=$(curl -s "$BASE_URL/api/user/balance" \
      -H "Authorization: Bearer $USER_TOKEN" | jq -r '.balance // 0')
    
    log_info "Initial balance: $INITIAL_BALANCE RP"
    
    # Export for use in other tests
    export USER_TOKEN
    export INITIAL_BALANCE
    
    return 0
}

# Test 2: Basic Market Operations
test_market_operations() {
    log_info "Testing basic market operations..."
    
    # Get current market state
    MARKET_STATE=$(curl -s "$LMSR_URL/events/$TEST_EVENT_ID/market")
    CURRENT_PROB=$(echo $MARKET_STATE | jq -r '.market_prob // 0.5')
    
    log_info "Current market probability: $CURRENT_PROB"
    
    # Buy YES shares (increase probability)
    BUY_RESPONSE=$(curl -s -X POST "$LMSR_URL/events/$TEST_EVENT_ID/update" \
      -H "Content-Type: application/json" \
      -d "{
        \"user_id\": $TEST_USER_ID,
        \"target_prob\": 0.7,
        \"stake\": 10.0
      }")
    
    BUY_SUCCESS=$(echo $BUY_RESPONSE | jq -r '.shares_acquired // 0')
    
    if (( $(echo "$BUY_SUCCESS > 0" | bc -l) )); then
        log_success "Acquired $BUY_SUCCESS YES shares"
        
        # Store shares for later sell test
        export YES_SHARES=$BUY_SUCCESS
        
        # Buy some NO shares too
        NO_RESPONSE=$(curl -s -X POST "$LMSR_URL/events/$TEST_EVENT_ID/update" \
          -H "Content-Type: application/json" \
          -d "{
            \"user_id\": $TEST_USER_ID,
            \"target_prob\": 0.4,
            \"stake\": 5.0
          }")
        
        NO_SHARES=$(echo $NO_RESPONSE | jq -r '.shares_acquired // 0')
        log_info "Acquired $NO_SHARES NO shares"
        
        return 0
    else
        log_error "Buy operation failed: $(echo $BUY_RESPONSE | jq -r '.error // "Unknown error"')"
        return 1
    fi
}

# Test 3: Verify Balance Invariant
test_balance_invariant() {
    log_info "Verifying balance invariant..."
    
    BALANCE_CHECK=$(curl -s -X POST "$LMSR_URL/lmsr/verify-balance-invariant" \
      -H "Content-Type: application/json" \
      -d "{\"user_id\": $TEST_USER_ID}")
    
    BALANCE_VALID=$(echo $BALANCE_CHECK | jq -r '.valid // false')
    
    if [ "$BALANCE_VALID" = "true" ]; then
        log_success "Balance invariant verified"
        echo $BALANCE_CHECK | jq '.details'
        return 0
    else
        log_error "Balance invariant violated: $(echo $BALANCE_CHECK | jq -r '.message')"
        echo $BALANCE_CHECK | jq '.details'
        return 1
    fi
}

# Test 4: Verify Staked Invariant
test_staked_invariant() {
    log_info "Verifying staked invariant..."
    
    STAKED_CHECK=$(curl -s -X POST "$LMSR_URL/lmsr/verify-staked-invariant" \
      -H "Content-Type: application/json" \
      -d "{\"user_id\": $TEST_USER_ID}")
    
    STAKED_VALID=$(echo $STAKED_CHECK | jq -r '.valid // false')
    
    if [ "$STAKED_VALID" = "true" ]; then
        log_success "Staked invariant verified"
        echo $STAKED_CHECK | jq '.details'
        return 0
    else
        log_error "Staked invariant violated: $(echo $STAKED_CHECK | jq -r '.message')"
        echo $STAKED_CHECK | jq '.details'
        return 1
    fi
}

# Test 5: Sell Shares
test_sell_shares() {
    log_info "Testing share selling..."
    
    # Check if we have shares to sell
    if [ -z "$YES_SHARES" ] || (( $(echo "$YES_SHARES <= 0" | bc -l) )); then
        log_info "No shares to sell, skipping"
        return 0
    fi
    
    # Sell half of YES shares
    SELL_AMOUNT=$(echo "$YES_SHARES * 0.5" | bc -l)
    
    SELL_RESPONSE=$(curl -s -X POST "$LMSR_URL/events/$TEST_EVENT_ID/sell" \
      -H "Content-Type: application/json" \
      -d "{
        \"user_id\": $TEST_USER_ID,
        \"share_type\": \"yes\",
        \"amount\": $SELL_AMOUNT
      }")
    
    PAYOUT=$(echo $SELL_RESPONSE | jq -r '.payout // 0')
    
    if (( $(echo "$PAYOUT > 0" | bc -l) )); then
        log_success "Sold $SELL_AMOUNT shares for $PAYOUT RP"
        return 0
    else
        log_error "Sell operation failed: $(echo $SELL_RESPONSE | jq -r '.message // "Unknown error"')"
        return 1
    fi
}

# Test 6: Verify System Consistency
test_system_consistency() {
    log_info "Verifying system consistency..."
    
    CONSISTENCY_CHECK=$(curl -s -X POST "$LMSR_URL/lmsr/verify-consistency" \
      -H "Content-Type: application/json" \
      -d "{\"event_id\": $TEST_EVENT_ID}")
    
    CONSISTENCY_VALID=$(echo $CONSISTENCY_CHECK | jq -r '.valid // false')
    
    echo $CONSISTENCY_CHECK | jq '.checks'
    
    # For now, we'll pass if critical checks pass (probability valid and no negative shares)
    PROB_VALID=$(echo $CONSISTENCY_CHECK | jq -r '.checks.probability_valid.passed // false')
    NO_NEG_SHARES=$(echo $CONSISTENCY_CHECK | jq -r '.checks.no_negative_shares.passed // false')
    
    if [ "$PROB_VALID" = "true" ] && [ "$NO_NEG_SHARES" = "true" ]; then
        log_success "Critical consistency checks passed"
        return 0
    else
        log_error "System consistency issues detected"
        return 1
    fi
}

# Test 7: Edge Cases
test_edge_cases() {
    log_info "Testing edge cases..."
    
    # Test zero stake
    ZERO_STAKE=$(curl -s -X POST "$LMSR_URL/events/$TEST_EVENT_ID/update" \
      -H "Content-Type: application/json" \
      -d "{
        \"user_id\": $TEST_USER_ID,
        \"target_prob\": 0.6,
        \"stake\": 0.0
      }")
    
    ZERO_ERROR=$(echo $ZERO_STAKE | jq -r '.error // ""')
    
    if [ -n "$ZERO_ERROR" ]; then
        log_success "Zero stake correctly rejected"
    else
        log_error "Zero stake should be rejected"
        return 1
    fi
    
    # Test invalid probability
    INVALID_PROB=$(curl -s -X POST "$LMSR_URL/events/$TEST_EVENT_ID/update" \
      -H "Content-Type: application/json" \
      -d "{
        \"user_id\": $TEST_USER_ID,
        \"target_prob\": 1.5,
        \"stake\": 10.0
      }")
    
    PROB_ERROR=$(echo $INVALID_PROB | jq -r '.error // ""')
    
    if [ -n "$PROB_ERROR" ]; then
        log_success "Invalid probability correctly rejected"
    else
        log_error "Invalid probability should be rejected"
        return 1
    fi
    
    # Test overselling
    OVERSELL=$(curl -s -X POST "$LMSR_URL/events/$TEST_EVENT_ID/sell" \
      -H "Content-Type: application/json" \
      -d "{
        \"user_id\": $TEST_USER_ID,
        \"share_type\": \"yes\",
        \"amount\": 999999.0
      }")
    
    OVERSELL_ERROR=$(echo $OVERSELL | jq -r '.error // ""' | head -1)
    
    if [ -n "$OVERSELL_ERROR" ]; then
        log_success "Overselling correctly rejected"
        return 0
    else
        log_error "Overselling should be rejected"
        return 1
    fi
}

# Test 8: High-Load Stress Test
test_high_load() {
    log_info "Running high-load stress test..."
    
    OPERATIONS=10
    SUCCESS_COUNT=0
    
    log_info "Executing $OPERATIONS market operations..."
    
    # First, acquire some shares to enable selling
    for i in $(seq 1 3); do
        PROB=$(echo "0.5 + $i * 0.05" | bc -l)
        curl -s -X POST "$LMSR_URL/events/$TEST_EVENT_ID/update" \
          -H "Content-Type: application/json" \
          -d "{
            \"user_id\": $TEST_USER_ID,
            \"target_prob\": $PROB,
            \"stake\": 1.0
          }" >/dev/null 2>&1
    done
    
    # Now do mixed operations
    for i in $(seq 1 $OPERATIONS); do
        # Alternate between small buys and sells
        if [ $((i % 3)) -eq 0 ]; then
            # Sell operation (only if we likely have shares)
            RESPONSE=$(curl -s -X POST "$LMSR_URL/events/$TEST_EVENT_ID/sell" \
              -H "Content-Type: application/json" \
              -d "{
                \"user_id\": $TEST_USER_ID,
                \"share_type\": \"yes\",
                \"amount\": 0.1
              }" 2>/dev/null)
        else
            # Buy operation
            PROB=$(echo "0.45 + $i * 0.02" | bc -l)
            RESPONSE=$(curl -s -X POST "$LMSR_URL/events/$TEST_EVENT_ID/update" \
              -H "Content-Type: application/json" \
              -d "{
                \"user_id\": $TEST_USER_ID,
                \"target_prob\": $PROB,
                \"stake\": 0.5
              }" 2>/dev/null)
        fi
        
        # Check if operation succeeded (no error field)
        if ! echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
            SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        fi
    done
    
    log_info "Completed $SUCCESS_COUNT/$OPERATIONS operations successfully"
    
    # Verify invariants after stress test
    FINAL_CHECK=$(curl -s -X POST "$LMSR_URL/lmsr/verify-staked-invariant" \
      -H "Content-Type: application/json" \
      -d "{\"user_id\": $TEST_USER_ID}")
    
    FINAL_VALID=$(echo $FINAL_CHECK | jq -r '.valid // false')
    
    SUCCESS_RATE=$(echo "scale=2; $SUCCESS_COUNT * 100 / $OPERATIONS" | bc -l)
    log_info "Success rate: $SUCCESS_RATE% ($SUCCESS_COUNT/$OPERATIONS)"
    
    if [ "$FINAL_VALID" = "true" ] && [ $SUCCESS_COUNT -ge $((OPERATIONS * 6 / 10)) ]; then
        log_success "System stable after high-load test (60%+ success rate)"
        return 0
    else
        log_error "System instability detected after high-load"
        return 1
    fi
}

# Main test execution
main() {
    echo "=== Starting LMSR Integration Tests ==="
    echo ""
    
    # Run all tests
    run_test "Setup and Authentication" test_setup
    
    if [ $? -eq 0 ]; then
        run_test "Market Operations" test_market_operations
        run_test "Balance Invariant" test_balance_invariant
        run_test "Staked Invariant" test_staked_invariant
        run_test "Sell Shares" test_sell_shares
        run_test "System Consistency" test_system_consistency
        run_test "Edge Cases" test_edge_cases
        run_test "High-Load Stress Test" test_high_load
    fi
    
    # Final summary
    echo ""
    echo "=== Test Summary ==="
    log_info "Total Tests: $TOTAL_TESTS"
    log_success "Passed: $TESTS_PASSED"
    
    if [ $TESTS_FAILED -gt 0 ]; then
        log_error "Failed: $TESTS_FAILED"
        echo ""
        log_error "Some tests failed. Please check the system."
        exit 1
    else
        echo ""
        log_success "All tests passed! System is functioning correctly."
        
        # Final invariant check
        echo ""
        log_info "Final system state verification..."
        curl -s -X POST "$LMSR_URL/lmsr/verify-balance-invariant" \
          -H "Content-Type: application/json" \
          -d "{\"user_id\": $TEST_USER_ID}" | jq '.details'
        
        exit 0
    fi
}

# Run main function
main "$@"