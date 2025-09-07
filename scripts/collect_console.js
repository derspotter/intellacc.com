#!/usr/bin/env node
/*
Usage:
  node scripts/collect_console.js [url] [durationMs]

Examples:
  node scripts/collect_console.js
  node scripts/collect_console.js http://localhost:5173 5000

Env overrides:
  CHROMIUM_PATH=/usr/bin/chromium
  HEADLESS=true|false (default true)
  NO_SANDBOX=true|false (default true)
  DISABLE_DEV_SHM=true|false (default true)

This script launches Chromium via Playwright and streams browser console,
page errors, and failed network requests to stdout.
*/

const { chromium } = require('@playwright/test');
const fs = require('fs');

(async () => {
  const url = process.argv[2] || 'http://localhost:5173';
  const duration = parseInt(process.argv[3] || '3000', 10);

  const configuredPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
  const headless = (process.env.HEADLESS || 'true') === 'true';
  const noSandbox = (process.env.NO_SANDBOX || 'true') === 'true';
  const disableDevShm = (process.env.DISABLE_DEV_SHM || 'true') === 'true';
  const token = process.env.TOKEN || '';

  const args = [];
  if (noSandbox) args.push('--no-sandbox');
  if (disableDevShm) args.push('--disable-dev-shm-usage');

  const useExecutablePath = (configuredPath && fs.existsSync(configuredPath)) ? configuredPath : undefined;
  console.error(`[collect_console] Launching Chromium at ${useExecutablePath || '(playwright default)'} headless=${headless} args=${args.join(' ')}`);

  const browser = await chromium.launch({ executablePath: useExecutablePath, headless, args });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Pre-inject token into localStorage before any scripts run
  if (token) {
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('token', t);
      } catch {}
    }, token);
    console.error('[collect_console] Injected TOKEN into localStorage');
  }

  // Idle-exit support
  const idleMs = parseInt(process.env.IDLE_MS || '0', 10); // if >0, exit after this many ms of no new logs
  let idleTimer = null;
  const resetIdle = () => {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`[auto-exit] idle for ${idleMs}ms, exiting`);
      browser.close().catch(() => {});
      process.exit(0);
    }, idleMs);
  };

  const exitOn = (process.env.EXIT_ON || '').toLowerCase(); // 'typing' | 'message'

  page.on('console', (msg) => {
    const text = msg.text();
    console.log(`[console] ${msg.type()} ${text}`);
    resetIdle();
  });

  page.on('pageerror', (err) => {
    console.log(`[pageerror] ${err.message}`);
    resetIdle();
  });

  page.on('requestfailed', (request) => {
    const failure = request.failure();
    console.log(`[requestfailed] ${request.method()} ${request.url()} -> ${failure && failure.errorText}`);
    resetIdle();
  });

  page.on('response', async (response) => {
    if (response.status() >= 400) {
      console.log(`[response] ${response.status()} ${response.url()}`);
    }
    resetIdle();
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    console.log(`[goto-error] ${e.message}`);
  }

  // Optional: auto navigate to hash and click conversations
  const autoHash = process.env.HASH || '';
  const autoClick = (process.env.AUTO_CLICK || 'false') === 'true';
  const clickDelay = parseInt(process.env.CLICK_DELAY || '600', 10);
  if (autoHash) {
    try {
      await page.evaluate((h) => { window.location.hash = h; }, autoHash);
      await page.waitForTimeout(500);
    } catch (e) {
      console.log(`[hash-error] ${e.message}`);
    }
  }
  if (autoClick) {
    try {
      await page.waitForSelector('[data-conversation-id]', { timeout: 10000 });
      const items = await page.$$('[data-conversation-id]');
      console.log(`[auto-click] found ${items.length} conversation rows`);
      for (let i = 0; i < Math.min(items.length, 3); i++) {
        const el = items[i];
        const id = await el.getAttribute('data-conversation-id');
        console.log(`[auto-click] clicking index=${i} id=${id}`);
        await el.click();
        await page.waitForTimeout(clickDelay);
      }
    } catch (e) {
      console.log(`[auto-click-error] ${e.message}`);
    }
  }

  // Optional: trigger a like as another user to verify room delivery
  const likePostId = process.env.LIKE_POST_ID;
  const likeToken = process.env.LIKE_TOKEN;
  if (likePostId && likeToken) {
    try {
      const res = await fetch(`http://localhost:3000/api/posts/${likePostId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${likeToken}` }
      });
      console.log(`[like-trigger] POST /api/posts/${likePostId}/like -> ${res.status}`);
    } catch (e) {
      console.log(`[like-trigger-error] ${e.message}`);
    }
  }

  // Optional: open a socket as another user and emit typing indicator in a conversation
  const senderToken = process.env.SENDER_TOKEN;
  const conversationId = process.env.CONVERSATION_ID ? parseInt(process.env.CONVERSATION_ID, 10) : null;
  const listenerToken = process.env.LISTENER_TOKEN || token; // default to page user token
  if ((senderToken || listenerToken) && conversationId) {
    try {
      const io = require('socket.io-client');

      // Listener socket: joins conversation room and logs typing events
      if (listenerToken) {
        const listener = io('http://localhost:3000', {
          path: '/socket.io',
          transports: ['websocket'],
          auth: { token: listenerToken }
        });
        listener.on('connect', () => {
          console.log(`[typing-listener] connected, joining conversation ${conversationId}`);
          listener.emit('join-conversation', conversationId);
        });
        listener.on('user-typing', (data) => {
          console.log(`[typing-listener] user-typing event: ${JSON.stringify(data)}`);
          if (exitOn === 'typing') {
            console.log('[auto-exit] exitOn typing matched, exiting');
            listener.close();
            browser.close().catch(() => {});
            process.exit(0);
          }
        });
        listener.on('connect_error', (err) => {
          console.log(`[typing-listener-error] ${err.message}`);
        });
      }

      // Sender socket: emits typing start/stop
      if (senderToken) {
        const s = io('http://localhost:3000', {
          path: '/socket.io',
          transports: ['websocket'],
          auth: { token: senderToken }
        });
        s.on('connect', () => {
          console.log(`[typing-trigger] connected as sender, emitting typing-start for conversation ${conversationId}`);
          s.emit('join-conversation', conversationId);
          s.emit('typing-start', { conversationId });
          setTimeout(() => {
            s.emit('typing-stop', { conversationId });
            s.close();
          }, 1500);
        });
        s.on('connect_error', (err) => {
          console.log(`[typing-trigger-error] ${err.message}`);
        });
      }
    } catch (e) {
      console.log(`[typing-trigger-error] ${e.message}`);
    }
  }

  // Optional: send a real message via API (encryptedContent can be placeholder; server stores as-is)
  const sendToken = process.env.SENDER_TOKEN;
  const recvId = process.env.RECEIVER_ID ? parseInt(process.env.RECEIVER_ID, 10) : null;
  const convId = process.env.CONVERSATION_ID ? parseInt(process.env.CONVERSATION_ID, 10) : null;
  const messageText = process.env.MESSAGE_TEXT || '';
  if (sendToken && recvId && convId && messageText) {
    try {
      const crypto = require('crypto');
      const contentHash = crypto.createHash('sha256').update(messageText, 'utf8').digest('hex');
      const fakeEnc = Buffer.from(messageText, 'utf8').toString('base64');
      const fakeSess = Buffer.from('session:' + messageText, 'utf8').toString('base64');
      const res = await fetch(`http://localhost:3000/api/messages/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sendToken}`
        },
        body: JSON.stringify({
          encryptedContent: fakeEnc,
          receiverId: recvId,
          contentHash: contentHash,
          receiverSessionKey: fakeSess,
          senderSessionKey: fakeSess,
          messageType: 'text'
        })
      });
      const body = await res.text();
      console.log(`[send-message] POST -> ${res.status} ${body}`);
      if (exitOn === 'message') {
        console.log('[auto-exit] exitOn message matched, exiting');
        await browser.close();
        process.exit(0);
      }
    } catch (e) {
      console.log(`[send-message-error] ${e.message}`);
    }
  }

  // If neither idle nor exitOn fired, fall back to duration
  await page.waitForTimeout(Math.max(0, duration));
  await browser.close();
})();
