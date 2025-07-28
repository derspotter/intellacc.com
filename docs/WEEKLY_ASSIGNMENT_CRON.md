# Weekly Assignment Cron Job Setup

This document explains how to set up and run the weekly assignment cron job that handles:

1. **Weekly Assignment Rewards**: +50 RP for users who complete assigned predictions with sufficient Kelly stake
2. **Weekly RP Decay**: 1% decay applied to all user RP balances
3. **New Weekly Assignments**: Random event assignment for all active users

## 🚀 Quick Start (Manual Testing)

For immediate testing or one-off runs:

```bash
# Run manual weekly process
./scripts/run_weekly_manual.sh
```

This will:
- Check if backend is running
- Copy the cron script to the backend container
- Execute weekly processes and show results

## 🐳 Docker Cron Service (Production)

For automated weekly execution:

### 1. Start the Cron Service

```bash
# Start weekly cron service alongside main application
docker compose -f docker-compose.yml -f docker-compose-cron.yml up -d

# Or start cron service only
docker compose -f docker-compose-cron.yml up -d
```

### 2. Environment Variables

Add to your `.env` file:

```bash
# Optional: Webhook URL for notifications (Slack/Discord)
WEEKLY_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

### 3. Monitor Cron Logs

```bash
# View cron service logs
docker logs intellacc_weekly_cron

# View cron execution logs
docker exec intellacc_weekly_cron tail -f /var/log/weekly_cron.log
```

## ⏰ Schedule Details

- **Frequency**: Every Monday at 2:00 AM UTC
- **Cron Expression**: `0 2 * * 1`
- **Process Order**:
  1. Process completed assignments from previous week
  2. Apply 1% RP decay to all users
  3. Assign new weekly predictions

## 🔧 Manual API Endpoints

You can also trigger individual processes via API:

```bash
# Process completed assignments
curl -X POST http://localhost:3000/api/weekly/process-completed

# Apply weekly decay
curl -X POST http://localhost:3000/api/weekly/apply-decay

# Assign new weekly predictions
curl -X POST http://localhost:3000/api/weekly/assign

# Run all processes in sequence
curl -X POST http://localhost:3000/api/weekly/run-all

# Get weekly statistics
curl http://localhost:3000/api/weekly/stats
```

## 📊 Weekly Process Logic

### Assignment Rewards (+50 RP)

Users receive +50 RP bonus if they:
1. Complete their assigned weekly prediction
2. Stake at least **1/4 of Kelly optimal amount**

Kelly calculation:
```javascript
const edge = belief > marketProb 
  ? (belief - marketProb) / (1 - marketProb)
  : (marketProb - belief) / marketProb;

const kellyOptimal = edge * balance * 0.25; // Conservative 25% Kelly
const requiredStake = kellyOptimal / 4.0;   // 1/4 of Kelly optimal
```

### RP Decay (1% Weekly)

- Applied to all users with RP balance > 100
- Prevents infinite RP accumulation
- Encourages active trading/betting

### New Assignments

- One random event per user per week
- Events must:
  - Close more than 7 days from now
  - Have initialized market probability
  - Have fewer than 50 existing predictions
  - Not already predicted on by the user

## 🚨 Troubleshooting

### Common Issues

1. **"Backend container not running"**
   ```bash
   docker compose -f docker-compose-dev.yml up -d
   ```

2. **"No suitable events available"**
   - Ensure events exist with closing dates > 7 days
   - Check market initialization (market_prob not null)

3. **"All users already have assignments"**
   - Normal if run multiple times in same week
   - Assignments reset automatically each Monday

### Logs and Debugging

```bash
# Backend API logs
docker logs intellacc_backend --tail 50

# Cron service logs
docker logs intellacc_weekly_cron

# Database connection test
docker exec intellacc_backend node -e "const db = require('./src/db'); db.query('SELECT NOW()').then(r => console.log('DB OK:', r.rows[0]))"
```

### Manual Database Inspection

```bash
# Check current week assignments
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "
SELECT u.username, e.title as assigned_event, u.weekly_assignment_week, u.weekly_assignment_completed
FROM users u 
LEFT JOIN events e ON u.weekly_assigned_event_id = e.id
WHERE u.weekly_assignment_week IS NOT NULL
ORDER BY u.username;"

# Check weekly decay log
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "
SELECT user_id, week_year, rp_before_decay, decay_amount, rp_after_decay
FROM weekly_decay_log 
ORDER BY processed_at DESC LIMIT 10;"
```

## 🔮 Future Enhancements

- **Health Checks**: API endpoint for cron job health monitoring
- **Retry Logic**: Automatic retry on transient failures
- **Configurable Schedule**: Environment variable for cron schedule
- **Advanced Notifications**: Rich webhook payloads with user stats
- **Performance Metrics**: Execution time tracking and optimization