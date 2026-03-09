module.exports = {
  name: '003_create_deal_flow',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        yacht_brand VARCHAR(255),
        yacht_model VARCHAR(255),
        yacht_year INTEGER,
        yacht_length_m NUMERIC(6,2),
        yacht_type VARCHAR(50) DEFAULT 'motor',
        trade_in_value NUMERIC(14,2),
        acquisition_price NUMERIC(14,2),
        acquisition_pct NUMERIC(5,2),
        seller_name VARCHAR(255),
        seller_email VARCHAR(255),
        seller_phone VARCHAR(100),
        seller_notes TEXT,
        new_boat_brand VARCHAR(255),
        new_boat_model VARCHAR(255),
        new_boat_price NUMERIC(14,2),
        shipyard_id INTEGER,
        shipyard_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'identified' CHECK (status IN ('identified','evaluating','offer_made','acquired','listed','sold','lost')),
        listing_price NUMERIC(14,2),
        final_sale_price NUMERIC(14,2),
        buyer_name VARCHAR(255),
        buyer_notes TEXT,
        total_expenses NUMERIC(14,2) DEFAULT 0,
        total_cost NUMERIC(14,2) DEFAULT 0,
        profit NUMERIC(14,2),
        roi_pct NUMERIC(8,2),
        notes TEXT,
        identified_at TIMESTAMPTZ DEFAULT NOW(),
        evaluating_at TIMESTAMPTZ,
        offer_made_at TIMESTAMPTZ,
        acquired_at TIMESTAMPTZ,
        listed_at TIMESTAMPTZ,
        sold_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deals_shipyard ON deals(shipyard_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deals_brand ON deals(yacht_brand)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS deal_expenses (
        id SERIAL PRIMARY KEY,
        deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
        category VARCHAR(255),
        description TEXT,
        amount NUMERIC(14,2),
        date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sale_records (
        id SERIAL PRIMARY KEY,
        deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
        buyer_name VARCHAR(255),
        buyer_email VARCHAR(255),
        buyer_phone VARCHAR(100),
        sale_price NUMERIC(14,2),
        commission_pct NUMERIC(5,2),
        commission_amount NUMERIC(14,2),
        payment_method VARCHAR(100),
        notes TEXT,
        sale_date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS shipyard_contacts (
        id SERIAL PRIMARY KEY,
        shipyard_name VARCHAR(255) NOT NULL,
        contact_name VARCHAR(255),
        contact_email VARCHAR(255),
        contact_phone VARCHAR(100),
        relationship_status VARCHAR(50) DEFAULT 'active',
        notes TEXT,
        total_deals INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const shipyards = ['Sanlorenzo','Azimut','Benetti','Ferretti Group','Riva','Custom Line','Mangusta','Wider Yachts'];
    for (const name of shipyards) {
      await client.query(`INSERT INTO shipyard_contacts (shipyard_name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
    }
  }
};
