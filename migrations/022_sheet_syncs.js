module.exports = {
  name: '022_sheet_syncs',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sheet_syncs (
        id              SERIAL PRIMARY KEY,
        status          VARCHAR(20) DEFAULT 'running',   -- 'running' | 'success' | 'failed'
        rows_fetched    INTEGER DEFAULT 0,
        rows_inserted   INTEGER DEFAULT 0,
        error_message   TEXT,
        started_at      TIMESTAMPTZ DEFAULT NOW(),
        completed_at    TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sheet_syncs_started_at ON sheet_syncs(started_at DESC)
    `);
    console.log('[022] Created sheet_syncs table');
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS sheet_syncs`);
    console.log('[022] Dropped sheet_syncs table');
  }
};
