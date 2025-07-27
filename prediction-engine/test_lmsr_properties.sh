#!/bin/bash

# Enhanced LMSR Integration Tests Script
# Tests the complete API/DB flow with invariant verification

echo "=== Enhanced LMSR Integration Tests ==="
echo "Testing complete API/DB flow with invariant verification..."

# Configuration
EVENT_ID=39
ADMIN_EMAIL="admin@example.com"
ADMIN_PASS="adminpass"
TEST_USER_EMAIL="user1@example.com"
TEST_USER_PASS="password123"
BASE_URL="http://localhost:3000"
LMSR_URL="http://localhost:3001"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper function for colored output
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }
log_info() { echo -e "${YELLOW}ℹ️  $1${NC}"; }

# Test result tracking
TESTS_PASSED=0
TESTS_FAILED=0
TOTAL_TESTS=0

run_test() {
    local test_name="$1"
    local test_command="$2"
    
    log_info "Running: $test_name"
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

# Setup function
setup_test_environment() {
    log_info "Setting up test environment..."
    
    # Get admin token
    ADMIN_TOKEN=$(curl -s -X POST $BASE_URL/api/login \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jq -r '.token')
    
    if [ "$ADMIN_TOKEN" = "null" ] || [ -z "$ADMIN_TOKEN" ]; then
        log_error "Failed to get admin token"
        return 1
    fi
    
    # Get user token
    USER_TOKEN=$(curl -s -X POST $BASE_URL/api/login \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$TEST_USER_EMAIL\",\"password\":\"$TEST_USER_PASS\"}" | jq -r '.token')
    
    if [ "$USER_TOKEN" = "null" ] || [ -z "$USER_TOKEN" ]; then
        log_error "Failed to get user token"
        return 1
    fi
    
    # Create test event
    EVENT_RESPONSE=$(curl -s -X POST $BASE_URL/api/events \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"title\":\"Integration Test Event\",\"description\":\"Complete integration test with invariants\",\"event_date\":\"2025-12-31\"}")
    
    log_success "Test environment setup complete"
    return 0
}

# Test 1: Basic market operations with invariant verification
test_basic_market_operations() {
    log_info "Test 1: Basic Market Operations"
    
    # Get initial user balance
    INITIAL_BALANCE=$(curl -s "$BASE_URL/api/user/balance" \
      -H "Authorization: Bearer $USER_TOKEN" | jq -r '.balance // 1000')
    
    # Buy YES shares
    BUY_RESPONSE=$(curl -s -X POST $LMSR_URL/lmsr/update \
      -H "Content-Type: application/json" \
      -d "{\"event_id\":$EVENT_ID,\"user_id\":1,\"target_prob\":0.7,\"stake\":50.0}")
    
    BUY_SUCCESS=$(echo $BUY_RESPONSE | jq -r '.success // false')
    SHARES_ACQUIRED=$(echo $BUY_RESPONSE | jq -r '.shares_acquired // 0')
    
    if [ "$BUY_SUCCESS" != "true" ] || (( $(echo "$SHARES_ACQUIRED <= 0" | bc -l) )); then
        log_error "Buy operation failed"
        return 1
    fi
    
    log_success "Acquired $SHARES_ACQUIRED YES shares"
    
    # Verify balance decreased
    BALANCE_AFTER_BUY=$(curl -s "$BASE_URL/api/user/balance" \
      -H "Authorization: Bearer $USER_TOKEN" | jq -r '.balance // 1000')
    
    if (( $(echo "$BALANCE_AFTER_BUY >= $INITIAL_BALANCE" | bc -l) )); then
        log_error "Balance should have decreased after buying shares"
        return 1
    fi
    
    # Buy NO shares
    NO_BUY_RESPONSE=$(curl -s -X POST $LMSR_URL/lmsr/update \
      -H "Content-Type: application/json" \
      -d "{\"event_id\":$EVENT_ID,\"user_id\":1,\"target_prob\":0.4,\"stake\":30.0}")
    
    # Sell partial YES shares
    if (( $(echo "$SHARES_ACQUIRED > 1.0" | bc -l) )); then
        SELL_AMOUNT=$(echo "$SHARES_ACQUIRED * 0.5" | bc -l)
        SELL_RESPONSE=$(curl -s -X POST $LMSR_URL/lmsr/sell \
          -H "Content-Type: application/json" \
          -d "{\"user_id\":1,\"event_id\":$EVENT_ID,\"share_type\":\"yes\",\"amount\":$SELL_AMOUNT}")
        
        SELL_SUCCESS=$(echo $SELL_RESPONSE | jq -r '.success // false')
        PAYOUT=$(echo $SELL_RESPONSE | jq -r '.payout // 0')
        
        if [ "$SELL_SUCCESS" = "true" ] && (( $(echo "$PAYOUT > 0" | bc -l) )); then
            log_success "Partial sell successful: $PAYOUT RP payout"
        else
            log_error "Partial sell failed"
            return 1
        fi
    fi
    
    return 0
}

# Test 2: Invariant verification
test_invariants() {
    log_info "Test 2: Financial Invariant Verification"
    
    # Test balance + staked = initial invariant
    BALANCE_CHECK=$(curl -s "$LMSR_URL/lmsr/verify-balance-invariant" \
      -H "Content-Type: application/json" \
      -d "{\"user_id\":1}")
    
    BALANCE_VALID=$(echo $BALANCE_CHECK | jq -r '.valid // false')
    
    if [ "$BALANCE_VALID" != "true" ]; then
        log_error "Balance invariant violated: $(echo $BALANCE_CHECK | jq -r '.message')"
        return 1
    fi
    
    # Test staked consistency invariant
    STAKED_CHECK=$(curl -s "$LMSR_URL/lmsr/verify-staked-invariant" \
      -H "Content-Type: application/json" \
      -d "{\"user_id\":1}")
    
    STAKED_VALID=$(echo $STAKED_CHECK | jq -r '.valid // false')
    
    if [ "$STAKED_VALID" != "true" ]; then
        log_error "Staked invariant violated: $(echo $STAKED_CHECK | jq -r '.message')"
        return 1
    fi
    
    log_success "All financial invariants verified"
    return 0
}

# Test 3: Resolution and cleanup
test_resolution() {
    log_info "Test 3: Event Resolution and Cleanup"
    
    # Resolve event as YES
    RESOLVE_RESPONSE=$(curl -s -X POST $LMSR_URL/lmsr/resolve \
      -H "Content-Type: application/json" \
      -d "{\"event_id\":$EVENT_ID,\"outcome\":true}")
    
    RESOLVE_SUCCESS=$(echo $RESOLVE_RESPONSE | jq -r '.success // false')
    
    if [ "$RESOLVE_SUCCESS" != "true" ]; then
        log_error "Event resolution failed"
        return 1
    fi
    
    # Verify post-resolution invariant
    POST_RESOLVE_CHECK=$(curl -s "$LMSR_URL/lmsr/verify-post-resolution" \
      -H "Content-Type: application/json" \
      -d "{\"event_id\":$EVENT_ID}")
    
    POST_RESOLVE_VALID=$(echo $POST_RESOLVE_CHECK | jq -r '.valid // false')
    
    if [ "$POST_RESOLVE_VALID" != "true" ]; then
        log_error "Post-resolution invariant violated"
        return 1
    fi
    
    # Try to trade on resolved event (should fail)
    POST_TRADE_RESPONSE=$(curl -s -X POST $LMSR_URL/lmsr/update \
      -H "Content-Type: application/json" \
      -d "{\"event_id\":$EVENT_ID,\"user_id\":1,\"target_prob\":0.8,\"stake\":10.0}")
    
    POST_TRADE_SUCCESS=$(echo $POST_TRADE_RESPONSE | jq -r '.success // true')
    
    if [ "$POST_TRADE_SUCCESS" = "true" ]; then
        log_error "Post-resolution trading should be blocked"
        return 1
    fi
    
    log_success "Event resolution and cleanup verified"
    return 0
}

# Test 4: Stress test with multiple concurrent operations
test_concurrent_operations() {
    log_info "Test 4: Concurrent Operations Stress Test"
    
    # Create new event for stress testing
    STRESS_EVENT_ID=$((EVENT_ID + 1))
    
    # Launch multiple concurrent buy operations
    PIDS=()
    for i in {1..5}; do
        (
            STAKE=$(echo "10 + $i * 2" | bc -l)
            PROB=$(echo "0.5 + $i * 0.05" | bc -l)
            curl -s -X POST $LMSR_URL/lmsr/update \
              -H "Content-Type: application/json" \
              -d "{\"event_id\":$STRESS_EVENT_ID,\"user_id\":1,\"target_prob\":$PROB,\"stake\":$STAKE}" > /dev/null
        ) &
        PIDS+=($!)
    done
    
    # Wait for all operations to complete
    for pid in "${PIDS[@]}"; do
        wait $pid
    done
    
    # Verify system consistency after concurrent operations
    CONSISTENCY_CHECK=$(curl -s "$LMSR_URL/lmsr/verify-consistency" \
      -H "Content-Type: application/json" \
      -d "{\"event_id\":$STRESS_EVENT_ID}")
    
    CONSISTENCY_VALID=$(echo $CONSISTENCY_CHECK | jq -r '.valid // false')
    
    if [ "$CONSISTENCY_VALID" != "true" ]; then
        log_error "System consistency violated after concurrent operations"
        return 1
    fi
    
    log_success "Concurrent operations handled correctly"
    return 0
}

# Test 5: Edge cases
test_edge_cases() {
    log_info "Test 5: Edge Case Handling"
    
    # Test zero stake
    ZERO_STAKE_RESPONSE=$(curl -s -X POST $LMSR_URL/lmsr/update \
      -H "Content-Type: application/json" \
      -d "{\"event_id\":$EVENT_ID,\"user_id\":1,\"target_prob\":0.6,\"stake\":0.0}")
    
    ZERO_STAKE_SUCCESS=$(echo $ZERO_STAKE_RESPONSE | jq -r '.success // true')
    
    if [ "$ZERO_STAKE_SUCCESS" = "true" ]; then
        log_error "Zero stake should be rejected"
        return 1
    fi
    
    # Test invalid probability
    INVALID_PROB_RESPONSE=$(curl -s -X POST $LMSR_URL/lmsr/update \
      -H "Content-Type: application/json" \
      -d "{\"event_id\":$EVENT_ID,\"user_id\":1,\"target_prob\":1.5,\"stake\":10.0}")
    
    INVALID_PROB_SUCCESS=$(echo $INVALID_PROB_RESPONSE | jq -r '.success // true')
    
    if [ "$INVALID_PROB_SUCCESS" = "true" ]; then
        log_error "Invalid probability should be rejected"
        return 1
    fi
    
    # Test overselling
    OVERSELL_RESPONSE=$(curl -s -X POST $LMSR_URL/lmsr/sell \
      -H "Content-Type: application/json" \
      -d "{\"user_id\":1,\"event_id\":$EVENT_ID,\"share_type\":\"yes\",\"amount\":999999.0}")
    
    OVERSELL_SUCCESS=$(echo $OVERSELL_RESPONSE | jq -r '.success // true')
    
    if [ "$OVERSELL_SUCCESS" = "true" ]; then
        log_error "Overselling should be rejected"
        return 1
    fi
    
    log_success "All edge cases handled correctly"
    return 0
}

# Main test execution
main() {
    echo "=== Enhanced LMSR Integration Tests ==="
    echo "Starting comprehensive API/DB flow testing..."
    echo ""
    
    # Setup
    if ! setup_test_environment; then
        log_error "Test environment setup failed"
        exit 1
    fi
    
    echo ""
    
    # Run all tests
    run_test "Basic Market Operations" test_basic_market_operations
    run_test "Financial Invariants" test_invariants  
    run_test "Event Resolution" test_resolution
    run_test "Concurrent Operations" test_concurrent_operations
    run_test "Edge Cases" test_edge_cases
    
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
        exit 0
    fi
}

# Run main function
main "$@"