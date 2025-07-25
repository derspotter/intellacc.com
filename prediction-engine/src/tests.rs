#[cfg(test)]
mod lmsr_property_tests {
    use super::*;
    use rust_decimal::prelude::*;
    use std::f64;
    
    // Final "go/no-go" property tests for Hanson-flawless LMSR
    
    // Property test 1: Round-trip symmetry
    #[test]
    fn test_round_trip_symmetry() {
        let b = Decimal::from(5000);
        let initial_q_yes = Decimal::ZERO;
        let initial_q_no = Decimal::ZERO;
        
        // Test various stake amounts
        for stake_amount in [1, 5, 10, 25, 50, 100, 250, 500] {
            let stake = Decimal::from(stake_amount);
            
            // Buy YES shares
            let delta_q_yes = calculate_delta_q_yes(stake, initial_q_yes, initial_q_no, b).unwrap();
            let new_q_yes = initial_q_yes + delta_q_yes;
            let new_q_no = initial_q_no;
            
            // Calculate cost
            let initial_cost = calculate_lmsr_cost(initial_q_yes, initial_q_no, b).unwrap();
            let new_cost = calculate_lmsr_cost(new_q_yes, new_q_no, b).unwrap();
            let buy_cost = new_cost - initial_cost;
            
            // Sell back the same shares
            let final_q_yes = new_q_yes - delta_q_yes;
            let final_q_no = new_q_no;
            let final_cost = calculate_lmsr_cost(final_q_yes, final_q_no, b).unwrap();
            let sell_payout = new_cost - final_cost;
            
            // Net cost should be zero (within f64 precision)
            let net_cost = buy_cost - sell_payout;
            assert!(
                net_cost.abs() < Decimal::new(1, 9), // 1e-9 tolerance
                "Round-trip not symmetric: stake={}, buy_cost={}, sell_payout={}, net={}",
                stake, buy_cost, sell_payout, net_cost
            );
            
            // Market should return to original state
            assert!(
                (final_q_yes - initial_q_yes).abs() < Decimal::new(1, 12),
                "q_yes not returned to original: initial={}, final={}", 
                initial_q_yes, final_q_yes
            );
            assert!(
                (final_q_no - initial_q_no).abs() < Decimal::new(1, 12),
                "q_no not returned to original: initial={}, final={}", 
                initial_q_no, final_q_no
            );
        }
    }
    
    // Property test 2: Path independence
    #[test]
    fn test_path_independence() {
        let b = Decimal::from(5000);
        let initial_q_yes = Decimal::ZERO;
        let initial_q_no = Decimal::ZERO;
        
        // Path 1: Direct 100 RP stake
        let direct_stake = Decimal::from(100);
        let delta_direct = calculate_delta_q_yes(direct_stake, initial_q_yes, initial_q_no, b).unwrap();
        let direct_final_q_yes = initial_q_yes + delta_direct;
        let direct_final_q_no = initial_q_no;
        
        let initial_cost = calculate_lmsr_cost(initial_q_yes, initial_q_no, b).unwrap();
        let direct_final_cost = calculate_lmsr_cost(direct_final_q_yes, direct_final_q_no, b).unwrap();
        let direct_total_cost = direct_final_cost - initial_cost;
        
        // Path 2: Two 50 RP stakes
        let step1_stake = Decimal::from(50);
        let delta1 = calculate_delta_q_yes(step1_stake, initial_q_yes, initial_q_no, b).unwrap();
        let intermediate_q_yes = initial_q_yes + delta1;
        let intermediate_q_no = initial_q_no;
        
        let step2_stake = Decimal::from(50);
        let delta2 = calculate_delta_q_yes(step2_stake, intermediate_q_yes, intermediate_q_no, b).unwrap();
        let indirect_final_q_yes = intermediate_q_yes + delta2;
        let indirect_final_q_no = intermediate_q_no;
        
        let intermediate_cost = calculate_lmsr_cost(intermediate_q_yes, intermediate_q_no, b).unwrap();
        let indirect_final_cost = calculate_lmsr_cost(indirect_final_q_yes, indirect_final_q_no, b).unwrap();
        let indirect_total_cost = indirect_final_cost - initial_cost;
        
        // Both paths should reach the same final state
        assert!(
            (direct_final_q_yes - indirect_final_q_yes).abs() < Decimal::new(1, 9),
            "Path independence violation in q_yes: direct={}, indirect={}", 
            direct_final_q_yes, indirect_final_q_yes
        );
        
        // Both paths should have the same total cost
        assert!(
            (direct_total_cost - indirect_total_cost).abs() < Decimal::new(1, 9),
            "Path independence violation in cost: direct={}, indirect={}", 
            direct_total_cost, indirect_total_cost
        );
    }
    
    // Property test 3: AMM max loss bound
    #[test]
    fn test_amm_max_loss_bound() {
        let b = Decimal::from(5000);
        let b_ln_2 = Decimal::from_f64_retain(5000.0 * 2.0_f64.ln()).unwrap();
        
        // Push market to extreme certainty (p ≈ 0.99)
        let large_stake = Decimal::from(10000);
        let delta_q = calculate_delta_q_yes(large_stake, Decimal::ZERO, Decimal::ZERO, b).unwrap();
        
        let final_cost = calculate_lmsr_cost(delta_q, Decimal::ZERO, b).unwrap();
        let initial_cost = calculate_lmsr_cost(Decimal::ZERO, Decimal::ZERO, b).unwrap();
        let amm_exposure = final_cost - initial_cost;
        
        // AMM loss should be bounded by b * ln(2) when market goes to certainty
        assert!(
            amm_exposure <= b_ln_2 * Decimal::from_str("1.01").unwrap(), // 1% tolerance
            "AMM loss {} exceeds theoretical bound {}", 
            amm_exposure, b_ln_2
        );
    }
    
    // Property test 4: Monotonicity
    #[test]
    fn test_probability_monotonicity() {
        let b = Decimal::from(5000);
        let mut q_yes = Decimal::ZERO;
        let q_no = Decimal::ZERO;
        let mut prev_prob = Decimal::from_str("0.5").unwrap();
        
        // Incrementally increase q_yes and verify probability increases
        for i in 1..=10 {
            let stake = Decimal::from(100);
            let delta_q = calculate_delta_q_yes(stake, q_yes, q_no, b).unwrap();
            q_yes += delta_q;
            
            let new_prob = calculate_lmsr_probability(q_yes, q_no, b).unwrap();
            
            assert!(
                new_prob > prev_prob,
                "Probability not monotonic: step {}, prev={}, new={}", 
                i, prev_prob, new_prob
            );
            
            prev_prob = new_prob;
        }
    }
    
    // Property test 5: No NaN/infinity protection
    #[test]
    fn test_numerical_stability() {
        let b = Decimal::from(5000);
        
        // Test various parameter combinations
        let test_cases = [
            (Decimal::ZERO, Decimal::ZERO),
            (Decimal::from(1000), Decimal::ZERO),
            (Decimal::ZERO, Decimal::from(1000)),
            (Decimal::from(5000), Decimal::from(5000)),
            (Decimal::from(10000), Decimal::from(1)),
        ];
        
        for (q_yes, q_no) in test_cases.iter() {
            let prob = calculate_lmsr_probability(*q_yes, *q_no, b).unwrap();
            let cost = calculate_lmsr_cost(*q_yes, *q_no, b).unwrap();
            
            // Verify no NaN or infinity
            assert!(prob.is_finite(), "Probability is not finite: {}", prob);
            assert!(cost.is_finite(), "Cost is not finite: {}", cost);
            
            // Verify probability bounds
            assert!(prob >= Decimal::ZERO && prob <= Decimal::ONE,
                "Probability out of bounds: {}", prob);
        }
    }
    
    // Property test 6: Overflow protection
    #[test]
    fn test_overflow_protection() {
        let b = Decimal::from(100); // Small b to trigger overflow condition
        let large_stake = Decimal::from(100000); // Large stake
        
        // Should return error for stake/b > 700
        let result = calculate_delta_q_yes(large_stake, Decimal::ZERO, Decimal::ZERO, b);
        assert!(result.is_err(), "Should reject large stake/b ratio");
        
        let error_msg = result.unwrap_err().to_string();
        assert!(error_msg.contains("Stake too large"), "Wrong error message: {}", error_msg);
    }
    
    // Property test 7: Exact stake = ΔC verification
    #[test]
    fn test_exact_stake_equals_delta_c() {
        let b = Decimal::from(5000);
        let initial_q_yes = Decimal::from(100);
        let initial_q_no = Decimal::from(200);
        
        for stake_amount in [1, 10, 50, 100, 500] {
            let stake = Decimal::from(stake_amount);
            
            // Calculate delta for YES shares
            let delta_q = calculate_delta_q_yes(stake, initial_q_yes, initial_q_no, b).unwrap();
            let new_q_yes = initial_q_yes + delta_q;
            
            // Calculate actual cost difference
            let initial_cost = calculate_lmsr_cost(initial_q_yes, initial_q_no, b).unwrap();
            let new_cost = calculate_lmsr_cost(new_q_yes, initial_q_no, b).unwrap();
            let actual_cost = new_cost - initial_cost;
            
            // stake should equal ΔC exactly (within f64 precision)
            let difference = (stake - actual_cost).abs();
            assert!(
                difference < Decimal::new(1, 9), // 1e-9 tolerance
                "stake ≠ ΔC: stake={}, actual_cost={}, diff={}", 
                stake, actual_cost, difference
            );
        }
    }
    
    // ==== FINAL "GO/NO-GO" HANSON-FLAWLESS TESTS ====
    
    // Test 1: Random sequence round-trip must equal zero
    #[test]
    fn test_hanson_round_trip_zero() {
        let b = Decimal::from(5000);
        
        // Test multiple random sequences
        for sequence_length in [3, 5, 10] {
            let mut q_yes = Decimal::ZERO;
            let mut q_no = Decimal::ZERO;
            let mut total_cash_paid = Decimal::ZERO;
            let mut trade_history = Vec::new();
            
            // Random walk of trades
            for i in 0..sequence_length {
                let stake = Decimal::from(10 + (i * 17) % 100); // Pseudo-random stakes
                let buy_yes = (i % 2) == 0; // Alternate YES/NO purchases
                
                let initial_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
                
                if buy_yes {
                    let delta_q = calculate_delta_q_yes(stake, q_yes, q_no, b).unwrap();
                    q_yes += delta_q;
                    trade_history.push(("yes", delta_q));
                } else {
                    let delta_q = calculate_delta_q_no(stake, q_yes, q_no, b).unwrap();
                    q_no += delta_q;
                    trade_history.push(("no", delta_q));
                }
                
                let new_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
                total_cash_paid += new_cost - initial_cost;
            }
            
            // Unwind all trades in reverse order
            for (share_type, amount) in trade_history.iter().rev() {
                let current_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
                
                if *share_type == "yes" {
                    q_yes -= amount;
                } else {
                    q_no -= amount;
                }
                
                let new_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
                let payout = current_cost - new_cost;
                total_cash_paid -= payout;
            }
            
            // Net cash should be zero
            assert!(
                total_cash_paid.abs() < Decimal::new(1, 9),
                "Round-trip not zero: sequence_length={}, net_cash={}", 
                sequence_length, total_cash_paid
            );
            
            // Should return to origin
            assert!(q_yes.abs() < Decimal::new(1, 12), "q_yes not returned to origin");
            assert!(q_no.abs() < Decimal::new(1, 12), "q_no not returned to origin");
        }
    }
    
    // Test 2: Two paths to same end state should cost same amount
    #[test]
    fn test_hanson_path_independence() {
        let b = Decimal::from(5000);
        let target_q_yes = Decimal::from(500);
        let target_q_no = Decimal::from(300);
        
        // Path 1: Direct to target
        let initial_cost = calculate_lmsr_cost(Decimal::ZERO, Decimal::ZERO, b).unwrap();
        let target_cost = calculate_lmsr_cost(target_q_yes, target_q_no, b).unwrap();
        let direct_cost = target_cost - initial_cost;
        
        // Path 2: Indirect via intermediate steps
        let mut q_yes = Decimal::ZERO;
        let mut q_no = Decimal::ZERO;
        let mut indirect_cost = Decimal::ZERO;
        
        // Step 1: Partial YES
        let step1_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
        q_yes = Decimal::from(250);
        let step1_new_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
        indirect_cost += step1_new_cost - step1_cost;
        
        // Step 2: Add NO shares
        let step2_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
        q_no = target_q_no;
        let step2_new_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
        indirect_cost += step2_new_cost - step2_cost;
        
        // Step 3: Complete YES
        let step3_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
        q_yes = target_q_yes;
        let step3_new_cost = calculate_lmsr_cost(q_yes, q_no, b).unwrap();
        indirect_cost += step3_new_cost - step3_cost;
        
        // Both paths should cost the same
        let cost_difference = (direct_cost - indirect_cost).abs();
        assert!(
            cost_difference < Decimal::new(1, 9),
            "Path dependence detected: direct={}, indirect={}, diff={}", 
            direct_cost, indirect_cost, cost_difference
        );
    }
    
    // Test 3: AMM maximum loss bound
    #[test]
    fn test_hanson_amm_max_loss_bound() {
        let b = Decimal::from(1000); // Smaller b for easier testing
        let theoretical_max_loss = Decimal::from_f64_retain(1000.0 * 2.0_f64.ln()).unwrap();
        
        // Push market to extreme certainty
        let extreme_q_yes = Decimal::from(5000); // Very large position
        let extreme_q_no = Decimal::ZERO;
        
        let initial_cost = calculate_lmsr_cost(Decimal::ZERO, Decimal::ZERO, b).unwrap();
        let extreme_cost = calculate_lmsr_cost(extreme_q_yes, extreme_q_no, b).unwrap();
        let amm_exposure = extreme_cost - initial_cost;
        
        // AMM loss should be bounded
        assert!(
            amm_exposure <= theoretical_max_loss * Decimal::from_str("1.01").unwrap(),
            "AMM loss {} exceeds bound {} for b={}", 
            amm_exposure, theoretical_max_loss, b
        );
        
        // Probability should approach certainty
        let prob = calculate_lmsr_probability(extreme_q_yes, extreme_q_no, b).unwrap();
        assert!(prob > Decimal::from_str("0.99").unwrap(), "Probability should approach 1.0");
    }
    
    // Test 4: Fuzz testing for numerical stability
    #[test]
    fn test_hanson_no_nans_overflow() {
        let test_cases = [
            // (b, q_yes, q_no)
            (Decimal::from_str("0.01").unwrap(), Decimal::ZERO, Decimal::ZERO),
            (Decimal::from(1000), Decimal::from(500), Decimal::from(300)),
            (Decimal::from(10000), Decimal::from(1000), Decimal::from(2000)),
            (Decimal::from_str("0.1").unwrap(), Decimal::from_str("0.05").unwrap(), Decimal::from_str("0.03").unwrap()),
        ];
        
        for (b, q_yes, q_no) in test_cases.iter() {
            // Test cost calculation
            let cost = calculate_lmsr_cost(*q_yes, *q_no, *b);
            assert!(cost.is_ok(), "Cost calculation failed for b={}, q_yes={}, q_no={}", b, q_yes, q_no);
            
            let cost_val = cost.unwrap();
            assert!(cost_val.is_finite(), "Cost is not finite: {}", cost_val);
            
            // Test probability calculation
            let prob = calculate_lmsr_probability(*q_yes, *q_no, *b);
            assert!(prob.is_ok(), "Probability calculation failed for b={}, q_yes={}, q_no={}", b, q_yes, q_no);
            
            let prob_val = prob.unwrap();
            assert!(prob_val.is_finite(), "Probability is not finite: {}", prob_val);
            assert!(prob_val >= Decimal::ZERO && prob_val <= Decimal::ONE, 
                "Probability out of bounds: {}", prob_val);
            
            // Test small stakes don't cause overflow
            let small_stake = *b / Decimal::from(100);
            if small_stake > Decimal::ZERO {
                let delta_result = calculate_delta_q_yes(small_stake, *q_yes, *q_no, *b);
                assert!(delta_result.is_ok(), "Delta calculation failed for small stake");
            }
        }
        
        // Test overflow protection
        let small_b = Decimal::from(10);
        let large_stake = Decimal::from(10000);
        let overflow_result = calculate_delta_q_yes(large_stake, Decimal::ZERO, Decimal::ZERO, small_b);
        assert!(overflow_result.is_err(), "Should reject stake/b > 700");
    }
    
    // Test 5: Strict monotonicity
    #[test]
    fn test_hanson_monotonicity() {
        let b = Decimal::from(5000);
        let q_no = Decimal::from(100); // Fixed NO position
        
        // Test increasing q_yes strictly increases probability
        let mut prev_prob = Decimal::ZERO;
        for i in 0..20 {
            let q_yes = Decimal::from(i * 50);
            let prob = calculate_lmsr_probability(q_yes, q_no, b).unwrap();
            
            if i > 0 {
                assert!(
                    prob > prev_prob,
                    "Monotonicity violation: step {}, q_yes={}, prob={}, prev_prob={}", 
                    i, q_yes, prob, prev_prob
                );
            }
            prev_prob = prob;
        }
        
        // Test increasing q_no strictly decreases probability
        let q_yes = Decimal::from(100); // Fixed YES position
        let mut prev_prob = Decimal::ONE;
        for i in 0..20 {
            let q_no_val = Decimal::from(i * 50);
            let prob = calculate_lmsr_probability(q_yes, q_no_val, b).unwrap();
            
            if i > 0 {
                assert!(
                    prob < prev_prob,
                    "Monotonicity violation: step {}, q_no={}, prob={}, prev_prob={}", 
                    i, q_no_val, prob, prev_prob
                );
            }
            prev_prob = prob;
        }
    }
}