module.exports = {
  name: '011_cockpit_schema',
  up: async (client) => {

    // ─── OUTREACH CHAINS ──────────────────────────────────────────────────────
    // Chains replace loose outreach_emails — each chain is a prospect's
    // multi-step sequence (LinkedIn D1, Email D3, Email D10, etc.)
    await client.query(`
      CREATE TABLE IF NOT EXISTS outreach_chains (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
        title VARCHAR(255),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_chains_prospect ON outreach_chains(prospect_id)`);

    // ─── OUTREACH CHAIN STEPS ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS outreach_chain_steps (
        id SERIAL PRIMARY KEY,
        chain_id INTEGER REFERENCES outreach_chains(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL DEFAULT 1,
        channel VARCHAR(50) NOT NULL DEFAULT 'email',
        subject TEXT,
        body TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','sent','replied','bounced','skipped')),
        scheduled_for DATE,
        sent_at TIMESTAMPTZ,
        replied_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chain_steps_chain ON outreach_chain_steps(chain_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chain_steps_status ON outreach_chain_steps(status)`);

    // ─── FUND ENTRIES ─────────────────────────────────────────────────────────
    // Tracks investor commitments toward the €30M Yacht Trade-In Arbitrage Fund
    await client.query(`
      CREATE TABLE IF NOT EXISTS fund_entries (
        id SERIAL PRIMARY KEY,
        investor_name VARCHAR(255) NOT NULL,
        amount_eur NUMERIC(15,2) NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'soft_commit'
          CHECK (status IN ('soft_commit','hard_commit','wired','withdrawn')),
        notes TEXT,
        committed_at DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fund_entries_status ON fund_entries(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fund_entries_committed ON fund_entries(committed_at DESC)`);

    // Seed one sample entry so the UI isn't completely empty on first load
    await client.query(`
      INSERT INTO fund_entries (investor_name, amount_eur, status, notes, committed_at)
      SELECT 'Barnes Yachting Founders', 500000, 'wired', 'Initial founders allocation', '2025-01-15'
      WHERE NOT EXISTS (SELECT 1 FROM fund_entries)
    `);
  }
};
