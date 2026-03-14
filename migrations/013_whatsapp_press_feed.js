module.exports = {
  name: '013_whatsapp_press_feed',

  up: async (client) => {
    // ─── WHATSAPP PRESS IMPORTS: Track each import run ──────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_press_imports (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(500),
        articles_parsed INTEGER DEFAULT 0,
        matches_found INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'completed',
        error_message TEXT,
        imported_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_press_imports_imported_at
        ON whatsapp_press_imports(imported_at DESC)
    `);

    // ─── PROSPECT_SIGNALS: Add source_type column for distinct badge rendering
    await client.query(`
      ALTER TABLE prospect_signals
        ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'web'
    `);

    // Back-fill: mark any existing WhatsApp press feed signals
    await client.query(`
      UPDATE prospect_signals
        SET source_type = 'whatsapp_press'
      WHERE source_name = 'WhatsApp Press Feed'
    `);

    console.log('[013] whatsapp_press_imports created; prospect_signals.source_type added');
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS whatsapp_press_imports`);
    await client.query(`ALTER TABLE prospect_signals DROP COLUMN IF EXISTS source_type`);
    console.log('[013] Rolled back whatsapp press feed schema');
  }
};
