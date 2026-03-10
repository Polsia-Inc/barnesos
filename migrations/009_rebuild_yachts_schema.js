module.exports = {
  name: '009_rebuild_yachts_schema',
  up: async (client) => {
    // Drop old yachts table entirely and rebuild with new CSV-driven schema
    await client.query(`DROP TABLE IF EXISTS yachts CASCADE`);

    await client.query(`
      CREATE TABLE yachts (
        id           SERIAL PRIMARY KEY,
        name         VARCHAR(500),
        builder      VARCHAR(500),
        length       NUMERIC(10,2),
        lob          NUMERIC(10,2),
        year_built   INTEGER,
        year_refit   INTEGER,
        price        NUMERIC(15,2),
        currency     VARCHAR(20),
        location_text TEXT,
        is_active    BOOLEAN DEFAULT TRUE,
        is_approved  BOOLEAN DEFAULT FALSE,
        brokers      TEXT,
        image_url    TEXT,
        extra_data   JSONB DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for all 12 filterable fields
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_name       ON yachts(name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_builder    ON yachts(builder)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_length     ON yachts(length)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_lob        ON yachts(lob)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_year_built ON yachts(year_built)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_year_refit ON yachts(year_refit)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_price      ON yachts(price)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_currency   ON yachts(currency)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_is_active  ON yachts(is_active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_is_approved ON yachts(is_approved)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_brokers    ON yachts USING gin(to_tsvector('simple', coalesce(brokers,'')))`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_location   ON yachts USING gin(to_tsvector('simple', coalesce(location_text,'')))`);

    console.log('[009] Rebuilt yachts table with new 12-field schema');
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS yachts`);

    // Recreate original schema for rollback
    await client.query(`
      CREATE TABLE yachts (
        id                    SERIAL PRIMARY KEY,
        brand                 VARCHAR(255) NOT NULL,
        model                 VARCHAR(255),
        length_m              NUMERIC(6,2),
        delivery              VARCHAR(255),
        location              VARCHAR(255),
        price_eur             NUMERIC(14,2),
        notes                 TEXT,
        has_discount          BOOLEAN DEFAULT FALSE,
        discount_pct          NUMERIC(5,2) DEFAULT 0,
        broker_commission_pct NUMERIC(5,2) DEFAULT 0,
        yacht_type            VARCHAR(50) DEFAULT 'motor',
        is_available          BOOLEAN DEFAULT TRUE,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }
};
