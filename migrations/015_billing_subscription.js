module.exports = {
  name: '015_billing_subscription',

  up: async (client) => {
    // ─── BILLING FIELDS ON TENANTS ────────────────────────────────────────────
    await client.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS billing_status    VARCHAR(20)  DEFAULT 'trial'
                                                   CHECK (billing_status IN ('trial','active','past_due','cancelled')),
        ADD COLUMN IF NOT EXISTS trial_ends_at     TIMESTAMPTZ  DEFAULT (NOW() + INTERVAL '14 days'),
        ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ
    `);
    console.log('[015] billing columns added to tenants');

    // Grandfather existing tenants (incl. demo) → mark as active so they don't get locked
    await client.query(`
      UPDATE tenants
      SET billing_status = 'active',
          subscription_started_at = NOW()
      WHERE billing_status = 'trial'
        AND created_at < NOW() - INTERVAL '1 minute'
    `);
    console.log('[015] existing tenants grandfathered to active');

    // ─── SUBSCRIPTION LINK STORE ──────────────────────────────────────────────
    // Store the Stripe link URL per-tenant (set at first checkout generation)
    await client.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS stripe_checkout_url TEXT
    `);
    console.log('[015] stripe_checkout_url column added');

    console.log('[015] billing_subscription migration complete');
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE tenants
        DROP COLUMN IF EXISTS billing_status,
        DROP COLUMN IF EXISTS trial_ends_at,
        DROP COLUMN IF EXISTS subscription_started_at,
        DROP COLUMN IF EXISTS stripe_checkout_url
    `);
    console.log('[015] Rolled back billing_subscription');
  }
};
