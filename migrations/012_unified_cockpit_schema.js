module.exports = {
  name: '012_unified_cockpit_schema',

  up: async (client) => {

    // ─── PROSPECTS: Add unified cockpit columns ──────────────────────────────
    // prospects already exists from 004_create_signal_radar
    // heat_tier and heat_score already exist; add cockpit aliases + new fields

    await client.query(`
      ALTER TABLE prospects
        ADD COLUMN IF NOT EXISTS tier VARCHAR(10),
        ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_signal_date TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS assigned_yacht_match_id INTEGER
    `);

    // Sync tier from heat_tier for existing rows (one-time backfill)
    await client.query(`
      UPDATE prospects SET tier = heat_tier WHERE tier IS NULL
    `);

    // Sync score from heat_score for existing rows
    await client.query(`
      UPDATE prospects SET score = heat_score WHERE score = 0 OR score IS NULL
    `);

    // Backfill last_signal_date from prospect_signals if available
    await client.query(`
      UPDATE prospects p
      SET last_signal_date = (
        SELECT MAX(detected_at)
        FROM prospect_signals ps
        WHERE ps.prospect_id = p.id
      )
      WHERE last_signal_date IS NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prospects_tier ON prospects(tier)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prospects_score ON prospects(score DESC)
    `);

    console.log('[012] prospects: added tier, score, last_signal_date, assigned_yacht_match_id');

    // ─── SIGNALS: New unified signals table ─────────────────────────────────
    // prospect_signals already exists for the signal radar page;
    // this new table is the cockpit-facing signals store (lighter schema)
    await client.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
        source TEXT,
        signal_type TEXT,
        weight INTEGER DEFAULT 1,
        detected_at TIMESTAMPTZ DEFAULT NOW(),
        raw_text TEXT
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_signals_prospect_id ON signals(prospect_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_signals_detected_at ON signals(detected_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source)
    `);

    // Backfill from prospect_signals so cockpit has existing signal data
    await client.query(`
      INSERT INTO signals (prospect_id, source, signal_type, weight, detected_at, raw_text)
      SELECT
        ps.prospect_id,
        COALESCE(ps.source_name, 'unknown') AS source,
        ps.signal_type,
        COALESCE(ps.score, 1) AS weight,
        ps.detected_at,
        COALESCE(ps.summary, ps.title) AS raw_text
      FROM prospect_signals ps
      ON CONFLICT DO NOTHING
    `);

    console.log('[012] signals: created and backfilled from prospect_signals');

    // ─── OUTREACH CHAINS: Add unified cockpit columns ────────────────────────
    // outreach_chains exists from 011 with (id, prospect_id, title, notes,
    // created_at, updated_at). Add cockpit fields for panel 3.
    await client.query(`
      ALTER TABLE outreach_chains
        ADD COLUMN IF NOT EXISTS yacht_id INTEGER REFERENCES yachts(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS step_number INTEGER DEFAULT 1,
        ADD COLUMN IF NOT EXISTS content TEXT,
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft',
        ADD COLUMN IF NOT EXISTS reply_preview TEXT,
        ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_outreach_chains_yacht ON outreach_chains(yacht_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_outreach_chains_status ON outreach_chains(status)
    `);

    // Backfill content from title+notes for existing chains
    await client.query(`
      UPDATE outreach_chains
      SET content = COALESCE(title, '') || CASE WHEN notes IS NOT NULL THEN E'\\n\\n' || notes ELSE '' END
      WHERE content IS NULL
    `);

    console.log('[012] outreach_chains: added yacht_id, step_number, content, status, reply_preview, sent_at');

    // ─── FUND ENTRIES: Add unified cockpit columns ───────────────────────────
    // fund_entries exists from 011 with (id, investor_name, amount_eur, status,
    // notes, committed_at, created_at, updated_at).
    // Add cockpit fields and expand status values.

    // Drop existing CHECK constraint on status (name unknown, drop all)
    // PostgreSQL lets us drop by name; we find it from pg_constraint
    await client.query(`
      DO $$
      DECLARE
        c TEXT;
      BEGIN
        SELECT constraint_name INTO c
        FROM information_schema.table_constraints
        WHERE table_name = 'fund_entries'
          AND constraint_type = 'CHECK'
          AND constraint_name LIKE '%status%';
        IF c IS NOT NULL THEN
          EXECUTE 'ALTER TABLE fund_entries DROP CONSTRAINT ' || quote_ident(c);
        END IF;
      END $$
    `);

    await client.query(`
      ALTER TABLE fund_entries
        ADD COLUMN IF NOT EXISTS commitment_amount NUMERIC(15,2),
        ADD COLUMN IF NOT EXISTS trade_in_asset TEXT,
        ADD COLUMN IF NOT EXISTS deal_stage TEXT,
        ADD COLUMN IF NOT EXISTS email VARCHAR(255)
    `);

    // Add new CHECK constraint covering all status values
    await client.query(`
      ALTER TABLE fund_entries
        ADD CONSTRAINT fund_entries_status_check
        CHECK (status IN ('lead','contacted','deck_sent','meeting','soft_commit','hard_commit','wired','withdrawn'))
    `);

    // Backfill commitment_amount from amount_eur for existing rows
    await client.query(`
      UPDATE fund_entries
      SET commitment_amount = amount_eur
      WHERE commitment_amount IS NULL AND amount_eur IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fund_entries_deal_stage ON fund_entries(deal_stage)
    `);

    console.log('[012] fund_entries: added commitment_amount, trade_in_asset, deal_stage, email; expanded status values');
  },

  down: async (client) => {
    // Drop new signals table
    await client.query(`DROP TABLE IF EXISTS signals`);

    // Remove added columns from prospects
    await client.query(`
      ALTER TABLE prospects
        DROP COLUMN IF EXISTS tier,
        DROP COLUMN IF EXISTS score,
        DROP COLUMN IF EXISTS last_signal_date,
        DROP COLUMN IF EXISTS assigned_yacht_match_id
    `);

    // Remove added columns from outreach_chains
    await client.query(`
      ALTER TABLE outreach_chains
        DROP COLUMN IF EXISTS yacht_id,
        DROP COLUMN IF EXISTS step_number,
        DROP COLUMN IF EXISTS content,
        DROP COLUMN IF EXISTS status,
        DROP COLUMN IF EXISTS reply_preview,
        DROP COLUMN IF EXISTS sent_at
    `);

    // Remove added columns from fund_entries
    await client.query(`ALTER TABLE fund_entries DROP CONSTRAINT IF EXISTS fund_entries_status_check`);
    await client.query(`
      ALTER TABLE fund_entries
        DROP COLUMN IF EXISTS commitment_amount,
        DROP COLUMN IF EXISTS trade_in_asset,
        DROP COLUMN IF EXISTS deal_stage,
        DROP COLUMN IF EXISTS email
    `);
    // Restore original status check
    await client.query(`
      ALTER TABLE fund_entries
        ADD CONSTRAINT fund_entries_status_check
        CHECK (status IN ('soft_commit','hard_commit','wired','withdrawn'))
    `);

    console.log('[012] Rolled back unified cockpit schema');
  }
};
