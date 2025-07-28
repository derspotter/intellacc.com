#!/usr/bin/env node

/**
 * Weekly Assignment Cron Job
 * 
 * Runs weekly tasks:
 * 1. Assign weekly predictions to all users
 * 2. Process completed assignments from previous week
 * 3. Apply 1% RP decay to all users
 * 
 * Schedule: Every Monday at 2 AM UTC
 * Cron: 0 2 * * 1
 */

const axios = require('axios');

const API_BASE = process.env.API_BASE || 'http://localhost:3000/api';
const WEBHOOK_URL = process.env.WEEKLY_WEBHOOK_URL; // Optional: Slack/Discord webhook

async function runWeeklyProcesses() {
  console.log(`\n🕐 Weekly Assignment Cron Job Started - ${new Date().toISOString()}`);
  console.log('='.repeat(60));
  
  try {
    // Step 1: Process completed assignments from previous week
    console.log('\n📋 Step 1: Processing completed assignments...');
    const completedResponse = await axios.post(`${API_BASE}/weekly/process-completed`);
    console.log(`✅ Completed assignments: ${JSON.stringify(completedResponse.data, null, 2)}`);
    
    // Step 2: Apply weekly decay (1%)
    console.log('\n📉 Step 2: Applying weekly RP decay...');
    const decayResponse = await axios.post(`${API_BASE}/weekly/apply-decay`);
    console.log(`✅ Weekly decay: ${JSON.stringify(decayResponse.data, null, 2)}`);
    
    // Step 3: Assign new weekly predictions
    console.log('\n🎯 Step 3: Assigning new weekly predictions...');
    const assignResponse = await axios.post(`${API_BASE}/weekly/assign`);
    console.log(`✅ New assignments: ${JSON.stringify(assignResponse.data, null, 2)}`);
    
    // Get weekly stats
    console.log('\n📊 Weekly Statistics:');
    const statsResponse = await axios.get(`${API_BASE}/weekly/stats`);
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

async function sendWebhookNotification(data) {
  try {
    const payload = {
      text: data.success ? 
        `✅ Weekly Assignment Process Completed Successfully\n\n` +
        `**Completed Assignments:** ${data.completed.rewarded} users rewarded, ${data.completed.skipped} skipped\n` +
        `**RP Decay:** ${data.decay.processed} users processed, ${data.decay.totalDecayAmount} RP decayed\n` +
        `**New Assignments:** ${data.assignments.assigned} new assignments for week ${data.assignments.week}\n` +
        `**Stats:** ${JSON.stringify(data.stats, null, 2)}`
        :
        `❌ Weekly Assignment Process Failed\n\n` +
        `**Error:** ${data.error}\n` +
        `**Details:** ${JSON.stringify(data.details, null, 2)}`
    };
    
    await axios.post(WEBHOOK_URL, payload);
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

// Run the weekly processes
runWeeklyProcesses();