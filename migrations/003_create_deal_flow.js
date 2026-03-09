/**
 * Migration: Create Deal Flow Tracker tables
 * Phase C of Trade-In Fund platform
 *
 * Tables: shipyard_contacts, deals, deal_expenses, sale_records
 */
module.exports = {
  name: '003_create_deal_flow',
  up: async (client) => {
    // Shipyard contacts — relationship tracker
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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shipyard_contacts_name ON shipyard_contacts(shipyard_name)
    `);

    // Deals — core deal pipeline
    await client.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,

        -- Yacht info
        yacht_brand VARCHAR(255) NOT NULL,
        yacht_model VARCHAR(255),
        yacht_year INTEGER,
        yacht_length_m DECIMAL(6,2),
        yacht_type VARCHAR(50) DEFAULT 'motor',

        -- Trade-in details
        trade_in_value BIGINT,
        acquisition_price BIGINT,
        acquisition_pct DECIMAL(5,2),

        -- Seller info
        seller_name VARCHAR(255),
        seller_email VARCHAR(255),
        seller_phone VARCHAR(100),
        seller_notes TEXT,

        -- New boat being purchased (triggers the trade-in)
        new_boat_brand VARCHAR(255),
        new_boat_model VARCHAR(255),
        new_boat_price BIGINT,

        -- Pipeline status
        status VARCHAR(50) DEFAULT 'identified',

        -- Shipyard relationship
        shipyard_id INTEGER REFERENCES shipyard_contacts(id) ON DELETE SET NULL,
        shipyard_name VARCHAR(255),

        -- Sale/resale fields
        listing_price BIGINT,
        final_sale_price BIGINT,
        sold_at TIMESTAMPTZ,
        buyer_name VARCHAR(255),
        buyer_notes TEXT,

        -- Computed P&L (updated on status change)
        total_expenses BIGINT DEFAULT 0,
        total_cost BIGINT DEFAULT 0,
        profit BIGINT,
        roi_pct DECIMAL(6,2),

        -- Timestamps
        identified_at TIMESTAMPTZ DEFAULT NOW(),
        evaluating_at TIMESTAMPTZ,
        offer_made_at TIMESTAMPTZ,
        acquired_at TIMESTAMPTZ,
        listed_at TIMESTAMPTZ,

        notes TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for pipeline queries
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deals_shipyard ON deals(shipyard_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deals_brand ON deals(yacht_brand)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deals_created ON deals(created_at DESC)`);

    // Check constraint for valid statuses
    await client.query(`
      ALTER TABLE deals ADD CONSTRAINT deals_status_check
      CHECK (status IN ('identified', 'evaluating', 'offer_made', 'acquired', 'listed', 'sold', 'lost'))
    `);

    // Deal expenses — refurbishment, survey, transport, etc.
    await client.query(`
      CREATE TABLE IF NOT EXISTS deal_expenses (
        id SERIAL PRIMARY KEY,
        deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        category VARCHAR(100) NOT NULL,
        description TEXT,
        amount BIGINT NOT NULL,
        date TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_deal_expenses_deal ON deal_expenses(deal_id)
    `);

    // Sale records — detailed sale tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS sale_records (
        id SERIAL PRIMARY KEY,
        deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        buyer_name VARCHAR(255),
        buyer_email VARCHAR(255),
        buyer_phone VARCHAR(100),
        sale_price BIGINT NOT NULL,
        commission_pct DECIMAL(5,2),
        commission_amount BIGINT,
        sale_date TIMESTAMPTZ DEFAULT NOW(),
        payment_method VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sale_records_deal ON sale_records(deal_id)
    `);

    // Seed the key shipyard partners
    await client.query(`
      INSERT INTO shipyard_contacts (shipyard_name, relationship_status, notes) VALUES
        ('Sanlorenzo', 'active', 'Key partner - Italian luxury yachts'),
        ('Azimut', 'active', 'Major Italian builder - Azimut-Benetti Group'),
        ('Benetti', 'active', 'Superyacht specialist - Azimut-Benetti Group'),
        ('Ferretti Group', 'active', 'Parent company: Ferretti, Riva, Pershing, Custom Line, Wally'),
        ('Riva', 'active', 'Ferretti Group brand - iconic Italian craftsmanship'),
        ('Custom Line', 'active', 'Ferretti Group brand - semi-custom yachts'),
        ('Mangusta', 'active', 'Overmarine Group - performance yachts'),
        ('Wider Yachts', 'active', 'Innovative hybrid propulsion yachts')
      ON CONFLICT DO NOTHING
    `);
  }
};
