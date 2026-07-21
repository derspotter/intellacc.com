// E2E: log-scaled, open-bounded numeric market — seeds a 4-bin log market with
// both tails directly in the DB (small bin count keeps the SQL legible; the
// engine validates against config.bin_count + tails, so 4+2=6 outcomes).
// Bins at 10^i: [1,10) [10,100) [100,1000) [1000,10000] + <1 and >10000 tails.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const { refundEventStakes } = require('./helpers/stakeRefund');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';
const psql = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -qtAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

test.describe('log-scaled open-tail numeric market', () => {
  let eventId;
  const title = `E2E log-tail market ${Date.now()}`;
  const B = 3466 / Math.log(6);

  test.beforeAll(() => {
    psql(`UPDATE users SET verification_tier = 2 WHERE email = 'user1@example.com'`);
    eventId = Number(psql(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob)
       VALUES ('${title}', 'e2e log seed', NOW() + INTERVAL '7 days', 'numeric', ${1 / 6})
       RETURNING id`
    ));
    // 4 inbound bins at powers of ten + two tails
    const rows = [
      ['bin_0', 'inbound', 1, 10, 0],
      ['bin_1', 'inbound', 10, 100, 1],
      ['bin_2', 'inbound', 100, 1000, 2],
      ['bin_3', 'inbound', 1000, 10000, 3],
      ['tail_low', 'lower_tail', null, 1, 4],
      ['tail_high', 'upper_tail', 10000, null, 5]
    ];
    for (const [key, kind, lo, hi, sort] of rows) {
      const oid = Number(psql(
        `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound, bucket_kind)
         VALUES (${eventId}, '${key}', '${key}', ${sort}, ${lo === null ? 'NULL' : lo}, ${hi === null ? 'NULL' : hi}, '${kind}')
         RETURNING id`
      ));
      psql(
        `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob, updated_at)
         VALUES (${eventId}, ${oid}, 0, ${1 / 6}, NOW())`
      );
    }
    psql(
      `INSERT INTO numeric_market_config
         (event_id, range_min, range_max, zero_point, open_lower_bound, open_upper_bound,
          unit, bin_count, transform, binning_version, b_numeric, numeric_market_version)
       VALUES (${eventId}, 1, 10000, 0, TRUE, TRUE, NULL, 4, 'log', 2, ${B}, 0)`
    );
  });

  test.afterAll(() => {
    if (eventId) {
      refundEventStakes(psql, String(eventId));
      psql(`DELETE FROM events WHERE id = ${eventId}`);
    }
    psql(`UPDATE users SET verification_tier = 1 WHERE email = 'user1@example.com'`);
  });

  test('renders tail bars and log ticks, trades and sells', async ({ page }) => {
    await page.goto(`${BASE}/#login`);
    await page.getByLabel(/email/i).fill('user1@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/#(home|feed)/, { timeout: 15000 });

    await page.goto(`${BASE}/#predictions/${eventId}`);
    const card = page.locator('.distribution-market-card');
    await expect(card).toBeVisible({ timeout: 15000 });

    // Both tails render as edge bars, and the axis is log-labeled.
    await expect(card.locator('.distribution-card-tail-bar')).toHaveCount(2);
    await expect(card.locator('.distribution-card-axis-label').filter({ hasText: '<1' })).toHaveCount(1);
    await expect(card.locator('.distribution-card-axis-label').filter({ hasText: '>10K' })).toHaveCount(1);
    await expect(card.locator('.distribution-card-axis-label').filter({ hasText: /^100$/ })).toHaveCount(1);

    // Trade: quote appears within budget, executes, position appears.
    await card.locator('.distribution-card-budget-input').fill('5');
    await expect(card.locator('.distribution-card-quote')).toBeVisible({ timeout: 15000 });
    await card.getByRole('button', { name: /^trade$/i }).click();
    await expect(card.locator('.distribution-card-position')).toBeVisible({ timeout: 15000 });

    // Sell it back via the inline two-step confirm (arm, then confirm);
    // position clears.
    await card.getByRole('button', { name: /sell all/i }).click();
    await card.getByRole('button', { name: /confirm sell/i }).click();
    await expect(card.locator('.distribution-card-position')).not.toBeVisible({ timeout: 15000 });
  });
});
