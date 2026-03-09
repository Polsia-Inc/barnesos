module.exports = {
  name: 'create_yachts',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS yachts (
        id SERIAL PRIMARY KEY,
        brand VARCHAR(100) NOT NULL,
        model VARCHAR(200) NOT NULL,
        length_m DECIMAL(6,2) NOT NULL,
        delivery VARCHAR(100),
        location VARCHAR(200),
        price_eur BIGINT NOT NULL,
        notes TEXT,
        has_discount BOOLEAN DEFAULT FALSE,
        discount_pct INTEGER DEFAULT 0,
        broker_commission_pct INTEGER DEFAULT 0,
        yacht_type VARCHAR(50) DEFAULT 'motor',
        is_available BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_yachts_brand ON yachts(brand);
      CREATE INDEX IF NOT EXISTS idx_yachts_price ON yachts(price_eur);
      CREATE INDEX IF NOT EXISTS idx_yachts_length ON yachts(length_m);
      CREATE INDEX IF NOT EXISTS idx_yachts_available ON yachts(is_available) WHERE is_available = TRUE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS match_requests (
        id SERIAL PRIMARY KEY,
        budget_min BIGINT,
        budget_max BIGINT,
        length_min DECIMAL(6,2),
        length_max DECIMAL(6,2),
        preferred_brands TEXT[],
        preferred_locations TEXT[],
        delivery_before VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }
};
