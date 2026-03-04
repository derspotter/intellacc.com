/**
 * daily_cron.js
 *
 * Runs daily tasks like the persuasive alpha scoring settlement.
 */

const http = require('http');
const https = require('https');

const API_BASE = process.env.API_BASE || 'http://backend:3000/api';
const ADMIN_TOKEN = process.env.WEEKLY_ADMIN_TOKEN;
const ADMIN_EMAIL = process.env.WEEKLY_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.WEEKLY_ADMIN_PASSWORD;

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const reqOptions = {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = client.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, data: parsed });
          } else {
            reject({ statusCode: res.statusCode, error: parsed });
          }
        } catch (e) {
          reject({ statusCode: res.statusCode, error: data });
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function getAuthHeaders() {
  if (ADMIN_TOKEN) {
    return { 'Authorization': `Bearer ${ADMIN_TOKEN}` };
  }

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const loginRes = await requestJson(`${API_BASE}/users/login`, {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    });
    return { 'Authorization': `Bearer ${loginRes.data.token}` };
  }

  throw new Error('No admin credentials provided for cron job');
}

async function runDailyTasks() {
  console.log('='.repeat(60));
  console.log(`Starting daily cron run at ${new Date().toISOString()}`);
  console.log('='.repeat(60));
  
  try {
    const headers = await getAuthHeaders();

    // Step 1: Run Persuasive Alpha Reward Scoring
    console.log('
💰 Step 1: Running Persuasive Alpha Reward Settlement...');
    const rewardsResponse = await requestJson(`${API_BASE}/admin/persuasion-score/run`, {
      method: 'POST',
      headers
    });
    console.log(`✅ Persuasive Alpha results: ${JSON.stringify(rewardsResponse.data, null, 2)}`);

  } catch (error) {
    console.error('
❌ Error in daily cron run:', JSON.stringify(error, null, 2));
    process.exit(1);
  }
}

runDailyTasks();
