module.exports = {
  name: '017_tenant_scan_scheduling',

  up: async (client) => {
    // ─── ADD SCAN CONFIG FIELDS TO TENANTS ───────────────────────────────────
    await client.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS scan_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS scan_frequency VARCHAR(20) NOT NULL DEFAULT 'daily',
        ADD COLUMN IF NOT EXISTS last_daily_scan_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS scan_timezone VARCHAR(50) NOT NULL DEFAULT 'UTC'
    `);
    console.log('[017] tenants: added scan_enabled, scan_frequency, last_daily_scan_at, scan_timezone');

    // ─── ADD scan_type 'scheduled' SUPPORT ───────────────────────────────────
    // scan_history.scan_type already accepts any varchar — just comment for clarity
    console.log('[017] scan_history: scan_type already supports "scheduled" (varchar)');

    // ─── INDEX for scheduler queries ─────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tenants_scan_enabled
        ON tenants(scan_enabled, last_daily_scan_at)
        WHERE scan_enabled = TRUE
    `);
    console.log('[017] Created index idx_tenants_scan_enabled');

    console.log('[017] tenant_scan_scheduling migration complete');
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_tenants_scan_enabled`);
    await client.query(`
      ALTER TABLE tenants
        DROP COLUMN IF EXISTS scan_enabled,
        DROP COLUMN IF EXISTS scan_frequency,
        DROP COLUMN IF EXISTS last_daily_scan_at,
        DROP COLUMN IF EXISTS scan_timezone
    `);
    console.log('[017] Rolled back tenant_scan_scheduling');
  }
};
