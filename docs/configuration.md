# LMSR Configuration System

The prediction engine now supports runtime configuration via environment variables for key market parameters.

## Environment Variables

### Hold Period Configuration

- **`MARKET_ENABLE_HOLD_PERIOD`** (boolean, default: `true`)
  - Controls whether users must wait before selling shares after purchase
  - Set to `false` to allow immediate selling (useful for testing)
  - Example: `MARKET_ENABLE_HOLD_PERIOD=false`

- **`MARKET_HOLD_PERIOD_HOURS`** (float, default: `1.0`)
  - Duration in hours that users must wait before selling
  - Only applies when `MARKET_ENABLE_HOLD_PERIOD=true`
  - Example: `MARKET_HOLD_PERIOD_HOURS=2.5`

### Kelly Criterion Configuration

- **`MARKET_KELLY_FRACTION`** (float, default: `0.25`)
  - Fraction of full Kelly criterion to suggest for conservative betting
  - Must be between 0.0 and `MARKET_MAX_KELLY_FRACTION`
  - Example: `MARKET_KELLY_FRACTION=0.5` (for 50% Kelly)

- **`MARKET_MAX_KELLY_FRACTION`** (float, default: `1.0`)
  - Maximum allowed Kelly fraction (safety limit)
  - Example: `MARKET_MAX_KELLY_FRACTION=0.75`

## Usage Examples

### Development/Testing (No Hold Period)
```bash
# Start prediction engine with immediate selling enabled
docker run -d \
  -e MARKET_ENABLE_HOLD_PERIOD=false \
  -e MARKET_KELLY_FRACTION=0.5 \
  intellacc_prediction_engine
```

### Conservative Production Setup
```bash
# Start with longer hold period and lower Kelly fraction
docker run -d \
  -e MARKET_ENABLE_HOLD_PERIOD=true \
  -e MARKET_HOLD_PERIOD_HOURS=24.0 \
  -e MARKET_KELLY_FRACTION=0.1 \
  intellacc_prediction_engine
```

### Aggressive Trading Setup
```bash
# Start with shorter hold period and higher Kelly fraction
docker run -d \
  -e MARKET_ENABLE_HOLD_PERIOD=true \
  -e MARKET_HOLD_PERIOD_HOURS=0.5 \
  -e MARKET_KELLY_FRACTION=0.75 \
  intellacc_prediction_engine
```

## Configuration Validation

The system automatically validates configuration values:

- Hold period hours must be positive
- Kelly fraction must be between 0.0 and max Kelly fraction
- Max Kelly fraction must be between 0.0 and 2.0
- Invalid values fall back to defaults with warnings

## Startup Logs

The prediction engine displays current configuration on startup:

```
🔧 Prediction Engine Configuration:
   Hold Period Enabled: false
   Hold Period Hours: 2
   Kelly Fraction: 0.5
   Max Kelly Fraction: 1
```

## API Impact

### Kelly Suggestion Endpoint
```
GET /events/:id/kelly?belief=0.7&user_id=1005
```

Response shows calculations based on configured Kelly fraction:
```json
{
  "kelly_suggestion": 909.76,    // Uses configured fraction
  "quarter_kelly": 227.44,       // Always 1/4 of kelly_suggestion
  "current_prob": 0.604745,
  "balance": 7550.0
}
```

### Sell Shares Endpoint
```
POST /events/:id/sell
```

Hold period validation is bypassed when `MARKET_ENABLE_HOLD_PERIOD=false`.

## Docker Compose Integration

Add to your `.env` file:
```bash
# Prediction Engine Configuration
MARKET_ENABLE_HOLD_PERIOD=false
MARKET_KELLY_FRACTION=0.5
MARKET_HOLD_PERIOD_HOURS=2.0
```

## Security Considerations

- **Hold Period**: Prevents rapid trading that could exploit market inefficiencies
- **Kelly Fraction**: Limits position sizes to reduce risk of significant losses
- **Configuration**: Changes require service restart for security

## Testing Configuration

Use the verification script to test configuration:
```bash
python3 test/verify-config-system.py
```

This verifies:
- Kelly fraction is properly applied to suggestions
- Hold period configuration is loaded correctly
- Environment variables override defaults

## Implementation Details

- Configuration is loaded once at startup in `src/config.rs`
- Hold period validation in `sell_shares_transaction()` respects `enable_hold_period`
- Kelly calculations use configurable `kelly_fraction` instead of hardcoded 0.25
- All market operations receive configuration via dependency injection

The configuration system provides production-ready flexibility while maintaining secure defaults for market operations.