module.exports = {
  name: '016_signal_radar_tenant_scoping',

  up: async (client) => {
    // ─── ADD tenant_id TO prospects ──────────────────────────────────────────
    await client.query(`
      ALTER TABLE prospects
        ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_prospects_tenant ON prospects(tenant_id)`);
    console.log('[016] prospects: added tenant_id');

    // ─── ADD tenant_id TO scan_history ───────────────────────────────────────
    await client.query(`
      ALTER TABLE scan_history
        ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_history_tenant ON scan_history(tenant_id)`);
    console.log('[016] scan_history: added tenant_id');

    // ─── ASSIGN EXISTING ROWS TO DEMO TENANT ──────────────────────────────────
    // All pre-existing prospects/scans belong to the barnes-demo tenant
    await client.query(`
      UPDATE prospects
        SET tenant_id = (SELECT id FROM tenants WHERE slug = 'barnes-demo' LIMIT 1)
      WHERE tenant_id IS NULL
    `);

    await client.query(`
      UPDATE scan_history sh
        SET tenant_id = (
          SELECT p.tenant_id FROM prospects p WHERE p.id = sh.prospect_id
        )
      WHERE sh.tenant_id IS NULL
    `);

    console.log('[016] Existing prospects/scan_history assigned to barnes-demo tenant');
    console.log('[016] signal_radar_tenant_scoping migration complete');
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_scan_history_tenant`);
    await client.query(`ALTER TABLE scan_history DROP COLUMN IF EXISTS tenant_id`);

    await client.query(`DROP INDEX IF EXISTS idx_prospects_tenant`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS tenant_id`);

    console.log('[016] Rolled back signal_radar_tenant_scoping');
  }
};
