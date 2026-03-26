exports.name = '024_additional_uhnwi_prospects';

exports.up = async (client) => {
  // Skip if we already have 40+ prospects (already migrated)
  const { rows } = await client.query('SELECT COUNT(*) FROM prospects');
  if (parseInt(rows[0].count) >= 40) {
    console.log('[Migration 024] Prospects already at 40+, skipping seed');
    return;
  }

  const prospects = [
    // Tech & Media Billionaires
    {
      name: 'Bill Gates',
      company: 'Microsoft / Gates Foundation',
      location: 'Seattle, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Wayfarer (73m, Feadship). Microsoft co-founder, net worth ~$130B. Known for summer sailing in the Mediterranean. Also charters large yachts for family vacations.',
      yacht_brand: 'Feadship',
      yacht_model: 'Wayfarer 73m',
    },
    {
      name: 'Elon Musk',
      company: 'Tesla / SpaceX / X',
      location: 'Austin, USA',
      heat_tier: 'cold',
      notes: 'Known yacht enthusiast. Previously chartered superyachts. Has expressed interest in a large custom build. Net worth ~$200B+. Frequent Monaco/Cannes circuit visitor.',
      yacht_brand: 'Custom',
      yacht_model: 'Potential new build',
    },
    {
      name: 'Steve Ballmer',
      company: 'LA Clippers / Microsoft (ex)',
      location: 'Los Angeles, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Mischief (74m, Oceanco). Former Microsoft CEO, net worth ~$100B+. NBA team owner. Actively enjoys the Mediterranean circuit.',
      yacht_brand: 'Oceanco',
      yacht_model: 'Mischief 74m',
    },
    {
      name: 'Michael Bloomberg',
      company: 'Bloomberg LP',
      location: 'New York, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Vendetta (58m, Oceanco, 2011). Former NYC Mayor, media mogul. Net worth ~$94B. Regular Bermuda race participant. Known for St. Barths and Caribbean cruising.',
      yacht_brand: 'Oceanco',
      yacht_model: 'Vendetta 58m',
    },
    {
      name: 'Jim Clark',
      company: 'Silicon Graphics / Netscape / Hyperion',
      location: 'Palm Beach, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Athena (90m, Royal Huisman). Silicon Valley pioneer — founded SGI, Netscape, Healtheon. One of Silicon Valley\'s most dedicated yachtsmen. Member of the RORC and various sailing clubs.',
      yacht_brand: 'Royal Huisman',
      yacht_model: 'Athena 90m',
    },
    {
      name: 'Giorgio Armani',
      company: 'Armani Group',
      location: 'Milan, Italy',
      heat_tier: 'cold',
      notes: 'Yacht: Main (65m, Codecasa). Italian fashion icon, net worth ~$9B. Frequently entertains guests on board off Sardinia and Capri. Deep connection to Italian maritime culture.',
      yacht_brand: 'Codecasa',
      yacht_model: 'Main 65m',
    },
    {
      name: 'François-Henri Pinault',
      company: 'Kering / Gucci / Saint Laurent',
      location: 'Paris, France',
      heat_tier: 'cold',
      notes: 'Yacht: Giraglia (multiple vessels). Chairman and CEO of Kering (Gucci, Bottega Veneta). Net worth ~$40B. Married to Salma Hayek. Regular participant in prestigious sailing races.',
      yacht_brand: 'Custom',
      yacht_model: 'Giraglia series',
    },
    {
      name: 'Francesca Fendi',
      company: 'Fendi / LVMH',
      location: 'Rome, Italy',
      heat_tier: 'cold',
      notes: 'Italian luxury heiress. Fendi family sold to LVMH. Known for superyacht presence at Rome and Sardinia during summer season. Net worth multi-billion.',
      yacht_brand: 'Riva',
      yacht_model: 'Custom luxury vessel',
    },
    {
      name: 'Mukesh Ambani',
      company: 'Reliance Industries',
      location: 'Mumbai, India',
      heat_tier: 'cold',
      notes: 'One of the world\'s wealthiest, net worth ~$80B+. Announced interest in acquiring a very large superyacht. Reliance Industries is India\'s largest conglomerate. Active UHNWI market participant.',
      yacht_brand: 'Oceanco',
      yacht_model: 'Potential 200m+ new build',
    },
    {
      name: 'Carlos Slim',
      company: 'América Móvil / Grupo Carso',
      location: 'Mexico City, Mexico',
      heat_tier: 'cold',
      notes: 'One of the wealthiest people in Latin America, net worth ~$90B. Known for discreet use of chartered superyachts. Telecommunications and real estate empire. UHNWI yacht market participant.',
      yacht_brand: 'Unknown',
      yacht_model: 'Charters large yachts',
    },
    {
      name: 'Andrey Guryev',
      company: 'PhosAgro',
      location: 'London, UK',
      heat_tier: 'cold',
      notes: 'Yacht: Tango (72m, Lürssen). Russian fertiliser billionaire, net worth ~$7B. UK-based. Known for hosting events at Witanhurst Estate. Active on Mediterranean yachting circuit.',
      yacht_brand: 'Lürssen',
      yacht_model: 'Tango 72m',
    },
    {
      name: 'Mikhail Prokhorov',
      company: 'Onexim Group',
      location: 'Moscow, Russia',
      heat_tier: 'cold',
      notes: 'Yacht: Palladium (88m). Russian billionaire, former Brooklyn Nets owner. Net worth ~$10B+. Yacht features basketball court on deck. Active in superyacht scene.',
      yacht_brand: 'CMN',
      yacht_model: 'Palladium 88m',
    },
    // Middle East / Asia
    {
      name: 'Sultan Haji Hassanal Bolkiah',
      company: 'Brunei Royal Family',
      location: 'Bandar Seri Begawan, Brunei',
      heat_tier: 'cold',
      notes: 'Yacht: Sunrider (66m). Sultan of Brunei owns an extensive fleet of superyachts (reportedly 200+). Net worth ~$28B. Major buyer of custom Feadship and Royal Denship vessels.',
      yacht_brand: 'Multiple',
      yacht_model: 'Fleet owner — 10+ vessels',
    },
    {
      name: 'Hamad bin Khalifa Al Thani',
      company: 'Qatar Royal Family (ex-Emir)',
      location: 'Doha, Qatar',
      heat_tier: 'cold',
      notes: 'Former Emir of Qatar. Yacht: Katara (124m, STX France). One of the most active yacht buyers in the world. QIA owns assets exceeding $500B. Major patron of the arts and sports.',
      yacht_brand: 'STX',
      yacht_model: 'Katara 124m',
    },
    {
      name: 'Naguib Sawiris',
      company: 'Orascom Telecom / Weather Investments',
      location: 'Cairo, Egypt',
      heat_tier: 'cold',
      notes: 'Yacht: Motor yacht private fleet. Egyptian billionaire, net worth ~$3B. Frequently spotted in Sardinia, Sicily, and Greek islands. Strong Mediterranean connection. Telecom and entertainment empire.',
      yacht_brand: 'Unknown',
      yacht_model: 'Private fleet',
    },
    // Europe / Finance
    {
      name: 'Philip Beresford',
      company: 'Bestway Group',
      location: 'London, UK',
      heat_tier: 'cold',
      notes: 'UK-based industrialist and one of Britain\'s wealthiest self-made billionaires. Known for discreet luxury including superyacht charter. Net worth ~$4B+.',
      yacht_brand: 'Unknown',
      yacht_model: 'Charter client',
    },
    {
      name: 'Stef Wertheimer',
      company: 'ISCAR / IMC Group',
      location: 'Tefen, Israel',
      heat_tier: 'cold',
      notes: 'Israeli industrial billionaire, founder of ISCAR (sold to Berkshire Hathaway). Net worth ~$5B. Known for Mediterranean cruising and interest in Israeli sailing culture.',
      yacht_brand: 'Unknown',
      yacht_model: 'Unknown vessel',
    },
    {
      name: 'Shari Arison',
      company: 'Carnival Corporation / Bank Hapoalim',
      location: 'Tel Aviv, Israel',
      heat_tier: 'cold',
      notes: 'Daughter of Carnival Corp founder Ted Arison. Major figure in the cruise and leisure industry. Net worth ~$4B. Deep understanding of marine luxury market from family heritage.',
      yacht_brand: 'Unknown',
      yacht_model: 'Private vessels',
    },
    {
      name: 'Len Blavatnik',
      company: 'Access Industries / Warner Music',
      location: 'London, UK',
      heat_tier: 'cold',
      notes: 'Yacht: Odessa II (72m, Feadship). Russian-American billionaire, net worth ~$32B. Warner Music, oil, chemicals empire. Regular fixture at St. Tropez and Monaco events.',
      yacht_brand: 'Feadship',
      yacht_model: 'Odessa II 72m',
    },
    {
      name: 'Gert Boyle',
      company: 'Columbia Sportswear (heirs)',
      location: 'Portland, USA',
      heat_tier: 'cold',
      notes: 'Columbia Sportswear dynasty. Heirs to the outdoor brand empire. Known for Pacific Northwest cruising and wilderness exploration by yacht. Net worth multi-billion (family).',
      yacht_brand: 'Unknown',
      yacht_model: 'Explorer vessels',
    },
    {
      name: 'Peter Thiel',
      company: 'Founders Fund / Palantir',
      location: 'San Francisco, USA',
      heat_tier: 'cold',
      notes: 'PayPal co-founder, Facebook early investor. Net worth ~$9B. Known for libertarian values and off-grid lifestyle including yacht use. New Zealand citizen. Interest in explorer and expedition yachts.',
      yacht_brand: 'Lurssen',
      yacht_model: 'Expedition vessel',
    },
    {
      name: 'Thomas Kaplan',
      company: 'Tigris Financial Group',
      location: 'New York, USA',
      heat_tier: 'cold',
      notes: 'American billionaire commodities investor. Net worth ~$3B. Known for wildlife conservation, art collection, and luxury marine assets. Regular on the Monaco/St. Barths social circuit.',
      yacht_brand: 'Unknown',
      yacht_model: 'Private vessel',
    },
    {
      name: 'Steve Wynn',
      company: 'Wynn Resorts / Mirage Resorts',
      location: 'Las Vegas, USA',
      heat_tier: 'cold',
      notes: 'Las Vegas casino mogul, net worth ~$3B+. Known for hosting VIP events on superyachts in the Mediterranean and Caribbean. Wynn Resorts is synonymous with ultra-luxury.',
      yacht_brand: 'Unknown',
      yacht_model: 'Charter client — large superyachts',
    },
  ];

  let inserted = 0;
  for (const p of prospects) {
    // Skip if already exists (by name)
    const { rows: existing } = await client.query(
      'SELECT id FROM prospects WHERE name = $1 LIMIT 1', [p.name]
    );
    if (existing.length > 0) continue;

    await client.query(
      `INSERT INTO prospects (name, company, location, heat_tier, notes, yacht_brand, yacht_model, date_added, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, NOW(), NOW())`,
      [p.name, p.company, p.location, p.heat_tier, p.notes, p.yacht_brand, p.yacht_model]
    );
    inserted++;
  }

  console.log(`[Migration 024] Inserted ${inserted} additional UHNWI prospects (skipped duplicates)`);
};

exports.down = async (client) => {
  const names = [
    'Bill Gates', 'Elon Musk', 'Steve Ballmer', 'Michael Bloomberg', 'Jim Clark',
    'Giorgio Armani', 'François-Henri Pinault', 'Francesca Fendi', 'Mukesh Ambani',
    'Carlos Slim', 'Andrey Guryev', 'Mikhail Prokhorov', 'Sultan Haji Hassanal Bolkiah',
    'Hamad bin Khalifa Al Thani', 'Naguib Sawiris', 'Philip Beresford', 'Stef Wertheimer',
    'Shari Arison', 'Len Blavatnik', 'Gert Boyle', 'Peter Thiel', 'Thomas Kaplan', 'Steve Wynn'
  ];
  for (const name of names) {
    await client.query(`DELETE FROM prospect_signals WHERE prospect_id IN (SELECT id FROM prospects WHERE name = $1)`, [name]);
    await client.query(`DELETE FROM prospects WHERE name = $1`, [name]);
  }
  console.log('[Migration 024] Rolled back: removed additional UHNWI prospects');
};
