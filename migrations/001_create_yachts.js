module.exports = {
  name: '001_create_yachts',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS yachts (
        id SERIAL PRIMARY KEY,
        brand VARCHAR(255) NOT NULL,
        model VARCHAR(255),
        length_m NUMERIC(6,2),
        delivery VARCHAR(255),
        location VARCHAR(255),
        price_eur NUMERIC(14,2),
        notes TEXT,
        has_discount BOOLEAN DEFAULT FALSE,
        discount_pct NUMERIC(5,2) DEFAULT 0,
        broker_commission_pct NUMERIC(5,2) DEFAULT 0,
        yacht_type VARCHAR(50) DEFAULT 'motor',
        is_available BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_brand ON yachts(brand)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_price ON yachts(price_eur)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_yachts_available ON yachts(is_available)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS match_requests (
        id SERIAL PRIMARY KEY,
        budget_min NUMERIC(14,2),
        budget_max NUMERIC(14,2),
        length_min NUMERIC(6,2),
        length_max NUMERIC(6,2),
        preferred_brands TEXT[],
        preferred_locations TEXT[],
        delivery_before VARCHAR(255),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }
};
