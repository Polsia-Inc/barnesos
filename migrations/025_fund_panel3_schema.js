module.exports = {
  name: 'fund_panel3_schema',

  async up(client) {
    // Add new columns to fund_entries for 6-stage investor pipeline
    await client.query(`
      ALTER TABLE fund_entries
        ADD COLUMN IF NOT EXISTS email TEXT,
        ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'contacted',
        ADD COLUMN IF NOT EXISTS prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL
    `);

    // Migrate existing status values to new stage column
    await client.query(`
      UPDATE fund_entries
      SET stage = status
      WHERE status IN ('soft_commit','hard_commit','wired','withdrawn')
        AND (stage = 'contacted' OR stage IS NULL)
    `);

    // Add columns to deals table for trade-in deal panel
    await client.query(`
      ALTER TABLE deals
        ADD COLUMN IF NOT EXISTS yacht_id INTEGER REFERENCES yachts(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS estimated_asset_value NUMERIC(14,2)
    `);

    // Index for fund_entries stage queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fund_entries_stage ON fund_entries(stage)
    `);

    // Index for deals yacht_id
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_deals_yacht_id ON deals(yacht_id)
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_fund_entries_stage`);
    await client.query(`DROP INDEX IF EXISTS idx_deals_yacht_id`);

    await client.query(`
      ALTER TABLE fund_entries
        DROP COLUMN IF EXISTS email,
        DROP COLUMN IF EXISTS stage,
        DROP COLUMN IF EXISTS prospect_id
    `);

    await client.query(`
      ALTER TABLE deals
        DROP COLUMN IF EXISTS yacht_id,
        DROP COLUMN IF EXISTS estimated_asset_value
    `);
  }
};
