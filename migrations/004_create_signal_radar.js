module.exports = {
  name: '004_create_signal_radar',
  up: async (client) => {
    // ─── PROSPECTS TABLE ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS prospects (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(100),
        company VARCHAR(255),
        location VARCHAR(255),
        current_yacht_interest TEXT,
        yacht_brand VARCHAR(255),
        yacht_model VARCHAR(255),
        social_handles JSONB DEFAULT '{}',
        notes TEXT,
        commercial_contact VARCHAR(255),
        heat_tier VARCHAR(10) DEFAULT 'cold' CHECK (heat_tier IN ('hot','warm','cold')),
        heat_score INTEGER DEFAULT 0,
        last_scanned_at TIMESTAMPTZ,
        date_added DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_prospects_tier ON prospects(heat_tier)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_prospects_score ON prospects(heat_score DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_prospects_name ON prospects(name)`);

    // ─── SIGNAL TRIGGER RULES ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS trigger_rules (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(50) NOT NULL CHECK (category IN ('high','medium','low')),
        keywords TEXT[] NOT NULL DEFAULT '{}',
        score_weight INTEGER NOT NULL DEFAULT 1,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed default trigger rules
    const rules = [
      // High intent (score 10)
      ['Company Exit / Sale', 'Prospect sold their company or had a major exit event', 'high',
       '{sold company,company exit,company acquired,acquisition complete,exit deal,sold business,company sale}', 10],
      ['IPO Event', 'Prospect company went public or filed for IPO', 'high',
       '{IPO,went public,initial public offering,stock listing,public offering,IPO filing}', 10],
      ['Major Funding Round', 'Prospect raised significant capital', 'high',
       '{raised funding,series funding,funding round,capital raise,investment round,venture capital,million raised}', 10],
      ['Liquidation Event', 'Major liquidity event like dividend or buyout', 'high',
       '{special dividend,buyout,cash out,liquidity event,private equity exit}', 10],

      // Medium intent (score 6)
      ['CEO/Chairman Promotion', 'Promoted to C-suite or chairman role', 'medium',
       '{appointed CEO,named chairman,promoted to CEO,new CEO,chairman of the board,chief executive}', 6],
      ['Board Appointment', 'Joined a corporate board', 'medium',
       '{joined board,board member,board appointment,board of directors,non-executive director}', 6],
      ['Senior Role Change', 'New senior executive position', 'medium',
       '{new role,appointed,promoted,joined as,managing director,senior partner,president}', 6],
      ['Major Award/Recognition', 'Industry recognition or award', 'medium',
       '{award,honored,recognized,top 100,billionaire list,rich list,wealth ranking}', 6],

      // Warm/Low intent (score 3)
      ['Yacht Brand Mention', 'Mentioned yacht brands or ownership', 'low',
       '{yacht,superyacht,megayacht,boat show,Sanlorenzo,Benetti,Ferretti,Azimut,Sunseeker,Princess,Riva,Mangusta,Wider}', 3],
      ['Boat Show Attendance', 'Attended or mentioned attending boat shows', 'low',
       '{Monaco Yacht Show,Fort Lauderdale,boat show,FLIBS,Cannes Yachting,Dubai boat show,Palm Beach boat show}', 3],
      ['Luxury Lifestyle Signal', 'Luxury purchases or lifestyle indicators', 'low',
       '{private jet,luxury real estate,penthouse,art collection,wine collection,polo,luxury travel}', 3],
      ['Yacht Account Follow', 'Follows yacht-related social accounts', 'low',
       '{yacht follow,yacht club,yacht life,sailing,marine,nautical,sea life}', 3]
    ];

    for (const [name, desc, cat, kw, score] of rules) {
      await client.query(
        `INSERT INTO trigger_rules (name, description, category, keywords, score_weight) VALUES ($1,$2,$3,$4,$5)`,
        [name, desc, cat, kw, score]
      );
    }

    // ─── PROSPECT SIGNALS (detected events) ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS prospect_signals (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
        trigger_rule_id INTEGER REFERENCES trigger_rules(id) ON DELETE SET NULL,
        signal_type VARCHAR(50) NOT NULL,
        title VARCHAR(500),
        summary TEXT,
        source_url TEXT,
        source_name VARCHAR(255),
        score INTEGER DEFAULT 0,
        raw_data JSONB DEFAULT '{}',
        detected_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_signals_prospect ON prospect_signals(prospect_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_signals_type ON prospect_signals(signal_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_signals_score ON prospect_signals(score DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_signals_detected ON prospect_signals(detected_at DESC)`);

    // ─── SCAN HISTORY ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS scan_history (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
        scan_type VARCHAR(50) DEFAULT 'daily',
        signals_found INTEGER DEFAULT 0,
        search_queries TEXT[],
        status VARCHAR(50) DEFAULT 'completed',
        error_message TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_prospect ON scan_history(prospect_id)`);
  }
};
