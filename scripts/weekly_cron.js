#!/usr/bin/env node

/**
 * Weekly Assignment Scheduler
 *
 * Runs weekly tasks:
 * 1. Process completed assignments from previous week
 * 2. Apply 1% RP decay to all users
 * 3. Assign new weekly predictions
 * 4. Auto-issue market-question rewards (traction + resolution)
 *
 * Schedule: Every Monday at 2 AM UTC
 */

const requestJson = async (url, { method = 'GET', headers = {}, body = null } = {}) => {
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  };

  if (body !== null && body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const error = new Error(`Request failed (${response.status})`);
    error.response = { status: response.status, data };
    throw error;
  }

  return { status: response.status, data };
};

const API_BASE = process.env.API_BASE || 'http://localhost:3000/api';
const WEBHOOK_URL = process.env.WEEKLY_WEBHOOK_URL; // Optional: Slack/Discord webhook
const ADMIN_TOKEN = process.env.WEEKLY_ADMIN_TOKEN;
const ADMIN_EMAIL = process.env.WEEKLY_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.WEEKLY_ADMIN_PASSWORD;
const CHECK_INTERVAL_MINUTES = Number(process.env.WEEKLY_CHECK_INTERVAL_MINUTES || '5');
const RUN_ON_START = process.env.WEEKLY_RUN_ON_START === '1';

const CHECK_INTERVAL_MS = Number.isFinite(CHECK_INTERVAL_MINUTES) && CHECK_INTERVAL_MINUTES > 0
  ? CHECK_INTERVAL_MINUTES * 60 * 1000
  : 5 * 60 * 1000;

const getAuthHeaders = async () => {
  if (ADMIN_TOKEN) {
    return { Authorization: `Bearer ${ADMIN_TOKEN}` };
  }

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const loginResponse = await requestJson(`${API_BASE}/login`, {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    });
    if (loginResponse.data?.token) {
      return { Authorization: `Bearer ${loginResponse.data.token}` };
    }
  }

  throw new Error('Weekly cron requires admin auth: set WEEKLY_ADMIN_TOKEN or WEEKLY_ADMIN_EMAIL/WEEKLY_ADMIN_PASSWORD');
};

async function runWeeklyProcesses() {
  console.log(`\n🕐 Weekly Assignment Cron Job Started - ${new Date().toISOString()}`);
  console.log('='.repeat(60));
  
  try {
    // Step 1: Process completed assignments from previous week
    console.log('\n📋 Step 1: Processing completed assignments...');
    const headers = await getAuthHeaders();
    const completedResponse = await requestJson(`${API_BASE}/weekly/process-completed`, {
      method: 'POST',
      headers
    });
    console.log(`✅ Completed assignments: ${JSON.stringify(completedResponse.data, null, 2)}`);
    
    // Step 2: Apply weekly decay (1%)
    console.log('\n📉 Step 2: Applying weekly RP decay...');
    const decayResponse = await requestJson(`${API_BASE}/weekly/apply-decay`, {
      method: 'POST',
      headers
    });
    console.log(`✅ Weekly decay: ${JSON.stringify(decayResponse.data, null, 2)}`);
    
    // Step 3: Assign new weekly predictions
    console.log('\n🎯 Step 3: Assigning new weekly predictions...');
    const assignResponse = await requestJson(`${API_BASE}/weekly/assign`, {
      method: 'POST',
      headers
    });
    console.log(`✅ New assignments: ${JSON.stringify(assignResponse.data, null, 2)}`);

    // Step 4: Auto-issue community market-question rewards
    console.log('\n💰 Step 4: Auto-issuing market-question rewards...');
    const rewardsResponse = await requestJson(`${API_BASE}/market-questions/rewards/run`, {
      method: 'POST',
      headers
    });
    console.log(`✅ Market-question rewards: ${JSON.stringify(rewardsResponse.data, null, 2)}`);
    
    // Get weekly stats
    console.log('\n📊 Weekly Statistics:');
    const statsResponse = await requestJson(`${API_BASE}/weekly/stats`, {
      method: 'GET',
      headers
    });
    console.log(`📈 Stats: ${JSON.stringify(statsResponse.data, null, 2)}`);
    
    console.log('\n🎉 Weekly processes completed successfully!');
    console.log('='.repeat(60));
    
    // Send webhook notification if configured
    if (WEBHOOK_URL) {
      await sendWebhookNotification({
        success: true,
        completed: completedResponse.data,
        decay: decayResponse.data,
        assignments: assignResponse.data,
        rewards: rewardsResponse.data,
        stats: statsResponse.data
      });
    }
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Error in weekly processes:', error.message);
    
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    
    // Send error webhook if configured
    if (WEBHOOK_URL) {
      await sendWebhookNotification({
        success: false,
        error: error.message,
        details: error.response?.data
      });
    }
    
    process.exit(1);
  }
}

const getIsoWeekKey = (date = new Date()) => {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  const year = target.getUTCFullYear();
  return `${year}-W${week.toString().padStart(2, '0')}`;
};

const shouldRunNow = (date = new Date()) => {
  const isMonday = date.getUTCDay() === 1;
  const isTwoAM = date.getUTCHours() === 2;
  const minuteWindow = date.getUTCMinutes() < Math.max(1, CHECK_INTERVAL_MINUTES);
  return isMonday && isTwoAM && minuteWindow;
};

const startScheduler = () => {
  let lastRunWeek = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    const now = new Date();
    if (!shouldRunNow(now)) return;

    const weekKey = getIsoWeekKey(now);
    if (lastRunWeek === weekKey) return;

    running = true;
    lastRunWeek = weekKey;
    try {
      await runWeeklyProcesses();
    } catch (error) {
      console.error('Scheduler run failed:', error.message);
    } finally {
      running = false;
    }
  };

  console.log(`Scheduler started. Checking every ${CHECK_INTERVAL_MS / 60000} minutes.`);

  if (RUN_ON_START) {
    tick().catch(() => {});
  }

  setInterval(() => {
    tick().catch(() => {});
  }, CHECK_INTERVAL_MS);
};

async function sendWebhookNotification(data) {
  try {
    const payload = {
      text: data.success ? 
        `✅ Weekly Assignment Process Completed Successfully\n\n` +
        `**Completed Assignments:** ${data.completed.rewarded} users rewarded, ${data.completed.skipped} skipped\n` +
        `**RP Decay:** ${data.decay.processed} users processed, ${data.decay.totalDecayAmount} RP decayed\n` +
        `**New Assignments:** ${data.assignments.assigned} new assignments for week ${data.assignments.week}\n` +
        `**Market Question Rewards:** traction=${data.rewards.traction_rewarded} resolved=${data.rewards.resolution_rewarded}\n` +
        `**Stats:** ${JSON.stringify(data.stats, null, 2)}`
        :
        `❌ Weekly Assignment Process Failed\n\n` +
        `**Error:** ${data.error}\n` +
        `**Details:** ${JSON.stringify(data.details, null, 2)}`
    };
    
    await requestJson(WEBHOOK_URL, { method: 'POST', body: payload });
    console.log('📤 Webhook notification sent');
  } catch (webhookError) {
    console.error('⚠️ Failed to send webhook notification:', webhookError.message);
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, exiting gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, exiting gracefully...');
  process.exit(0);
});

// Run once or start daemon scheduler
if (process.argv.includes('--daemon')) {
  startScheduler();
} else {
  runWeeklyProcesses();
}
