exports.name = '010_replace_prospects_with_uhnwi';

exports.up = async (client) => {
  // Clear existing demo/placeholder data
  await client.query('DELETE FROM prospect_signals WHERE prospect_id IN (SELECT id FROM prospects)');
  await client.query('DELETE FROM scan_history WHERE prospect_id IN (SELECT id FROM prospects)');
  await client.query('DELETE FROM prospects');

  const prospects = [
    // Tech Billionaires
    {
      name: 'Jeff Bezos',
      company: 'Amazon',
      location: 'Miami, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Koru (126m, built by Oceanco, 2023). One of the largest sailing yachts ever built. Also owns support vessel Abeona.',
      yacht_brand: 'Oceanco',
      yacht_model: 'Koru 126m',
    },
    {
      name: 'Mark Zuckerberg',
      company: 'Meta / Facebook',
      location: 'Palo Alto, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Launchpad (118m, Feadship, 2023). Named after a space theme. Anchored frequently in Hawaii and Mediterranean.',
      yacht_brand: 'Feadship',
      yacht_model: 'Launchpad 118m',
    },
    {
      name: 'Sergey Brin',
      company: 'Google',
      location: 'San Francisco, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Dragonfly (142m, Lürssen). One of the largest superyachts ever built. Has kite-surfing features and helicopter hangar.',
      yacht_brand: 'Lürssen',
      yacht_model: 'Dragonfly 142m',
    },
    {
      name: 'Larry Ellison',
      company: 'Oracle',
      location: 'San Francisco, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Musashi (88m, Feadship). Previously owned Rising Sun. Known for aggressive racing and AC team ownership (Oracle Racing).',
      yacht_brand: 'Feadship',
      yacht_model: 'Musashi 88m',
    },
    {
      name: 'Eric Schmidt',
      company: 'ex-Google CEO',
      location: 'San Francisco, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Whisper (95m, Lürssen). Frequently cruises Mediterranean and Caribbean. Low public profile on yachting.',
      yacht_brand: 'Lürssen',
      yacht_model: 'Whisper 95m',
    },
    {
      name: 'Jan Koum',
      company: 'WhatsApp',
      location: 'San Francisco, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Moonrise (101m, Feadship). WhatsApp co-founder sold to Meta for $19B. Avid classic car collector. Low media profile.',
      yacht_brand: 'Feadship',
      yacht_model: 'Moonrise 101m',
    },
    {
      name: 'Evan Spiegel',
      company: 'Snapchat',
      location: 'Los Angeles, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Bliss (95m, Feadship). Snapchat co-founder. Wife Miranda Kerr is a frequent crew presence. Regularly spotted in Ibiza and Cannes.',
      yacht_brand: 'Feadship',
      yacht_model: 'Bliss 95m',
    },
    {
      name: 'Larry Page',
      company: 'Google',
      location: 'San Francisco, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Senses (59m). Google co-founder and Alphabet CEO. Very private — avoids press. Interested in sustainable yachting innovations.',
      yacht_brand: 'Unknown',
      yacht_model: 'Senses 59m',
    },
    {
      name: 'Barry Diller',
      company: 'IAC / Expedia',
      location: 'New York, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Eos (93m, Lürssen, 2006). Three-masted sailing yacht. Regularly visits Mediterranean with wife Diane von Furstenberg. Active on the social circuit.',
      yacht_brand: 'Lürssen',
      yacht_model: 'Eos 93m',
    },
    {
      name: 'Charles Simonyi',
      company: 'Microsoft (ex)',
      location: 'Seattle, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Norn (90m, Lürssen). Former Microsoft Chief Architect. Twice-traveled to the ISS as a space tourist. Passionate sailor.',
      yacht_brand: 'Lürssen',
      yacht_model: 'Norn 90m',
    },
    // Global UHNWI / Industrialists
    {
      name: 'Roman Abramovich',
      company: 'Evraz / Chelsea FC (ex)',
      location: 'Moscow, Russia',
      heat_tier: 'cold',
      notes: 'Yachts: Eclipse (162m, Blohm+Voss) — one of world\'s largest private yachts; Solaris (140m, Lloyd Werft). Sanctioned post-2022. Fleet status uncertain. Net worth ~$9B.',
      yacht_brand: 'Blohm+Voss',
      yacht_model: 'Eclipse 162m + Solaris 140m',
    },
    {
      name: 'Alisher Usmanov',
      company: 'USM Holdings',
      location: 'Moscow, Russia',
      heat_tier: 'cold',
      notes: 'Yacht: Dilbar (157m, Lürssen) — world\'s largest yacht by interior volume. Sanctioned EU/UK post-2022; Dilbar seized in Hamburg. Net worth ~$14.4B.',
      yacht_brand: 'Lürssen',
      yacht_model: 'Dilbar 157m',
    },
    {
      name: 'Joe Lewis',
      company: 'Tavistock Group',
      location: 'London, UK',
      heat_tier: 'cold',
      notes: 'Yacht: Aviva (68m, Feadship, 2014). UK-born investor, owns 20%+ of Tottenham Hotspur FC. Net worth ~$7.6B. Frequently in Caribbean.',
      yacht_brand: 'Feadship',
      yacht_model: 'Aviva 68m',
    },
    {
      name: 'Bernard Arnault',
      company: 'LVMH',
      location: 'Paris, France',
      heat_tier: 'cold',
      notes: 'Yacht: Symphony (101m, Feadship). World\'s richest person (periodically). Regularly cruises the Mediterranean. LVMH controls Louis Vuitton, Dior, Bulgari, and 75+ luxury brands.',
      yacht_brand: 'Feadship',
      yacht_model: 'Symphony 101m',
    },
    {
      name: 'Amancio Ortega',
      company: 'Inditex / Zara',
      location: 'Madrid, Spain',
      heat_tier: 'cold',
      notes: 'Yacht: Unnamed Feadship 92m. Zara founder, second richest person in Europe. Extremely private — almost no public appearances. Net worth ~$75B.',
      yacht_brand: 'Feadship',
      yacht_model: 'Feadship 92m',
    },
    {
      name: 'Hans Peter Wild',
      company: 'Wild Group / Capri Sun',
      location: 'Munich, Germany',
      heat_tier: 'cold',
      notes: 'Yacht: 80m+ superyacht. Capri Sun owner, net worth ~$4B. Low-profile German industrialist. Yachting is a key leisure pursuit.',
      yacht_brand: 'Unknown',
      yacht_model: '80m+ superyacht',
    },
    {
      name: 'Jerry Jones',
      company: 'Dallas Cowboys (NFL)',
      location: 'Dallas, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Bravo Eugenia (109m, Feadship). NFL owner and oil/gas billionaire. Net worth ~$15B. Frequently hosts business and celebrity guests on board.',
      yacht_brand: 'Feadship',
      yacht_model: 'Bravo Eugenia 109m',
    },
    {
      name: 'David Geffen',
      company: 'DreamWorks / Geffen Records',
      location: 'Los Angeles, USA',
      heat_tier: 'cold',
      notes: 'Yacht: Rising Sun (138m, Lürssen, 2004). Entertainment mogul — co-founded DreamWorks and Geffen Records. Net worth ~$9B. Hosts A-list celebrity events on board.',
      yacht_brand: 'Lürssen',
      yacht_model: 'Rising Sun 138m',
    },
    {
      name: 'Michael Latifi',
      company: 'Sofina Foods',
      location: 'Montreal, Canada',
      heat_tier: 'cold',
      notes: 'Yacht: Private megayacht. Canadian billionaire, owner of Sofina Foods (meat processing). Father of former F1 driver Nicholas Latifi. Net worth ~$2B. Also invests in McLaren F1 team.',
      yacht_brand: 'Unknown',
      yacht_model: 'Private megayacht',
    },
    // Middle East / Royalty
    {
      name: 'Al Nahyan Family',
      company: 'Abu Dhabi Ruling Family',
      location: 'Abu Dhabi, UAE',
      heat_tier: 'cold',
      notes: 'Yacht: Azzam (180m, Lürssen, 2013) — world\'s largest private superyacht. Fleet of 10+ superyachts including Abdul Aziz. Sovereign wealth fund (ADIA) manages ~$900B+ AUM.',
      yacht_brand: 'Lürssen',
      yacht_model: 'Azzam 180m + fleet',
    },
    {
      name: 'Sheikh Mohammed bin Rashid Al Maktoum',
      company: 'Dubai Government / Ruler',
      location: 'Dubai, UAE',
      heat_tier: 'cold',
      notes: 'Yacht: Dubai (162m, Blohm+Voss, 2006). PM of UAE and Ruler of Dubai. Personal net worth ~$14B. World-class horse owner. Active on yachting circuit.',
      yacht_brand: 'Blohm+Voss',
      yacht_model: 'Dubai 162m',
    },
    {
      name: 'Mohammed bin Salman',
      company: 'Saudi Arabia Crown Prince',
      location: 'Riyadh, Saudi Arabia',
      heat_tier: 'cold',
      notes: 'Yacht: Serene (134m, Fincantieri, 2011) — acquired for ~$500M. Also purchased Leonardo da Vinci\'s Salvator Mundi for $450M. Saudi Aramco chairman. Drives Vision 2030.',
      yacht_brand: 'Fincantieri',
      yacht_model: 'Serene 134m',
    },
    {
      name: 'Hamad bin Jassim Al Thani',
      company: 'Qatar Investment Authority (ex-PM)',
      location: 'Doha, Qatar',
      heat_tier: 'cold',
      notes: 'Yacht: Al Mirqab (133m, Peters Schiffbau, 2008). Former PM and FM of Qatar. Managed QIA during its peak acquisitions of Harrods, Barclays, and PSG. Net worth ~$10B.',
      yacht_brand: 'Peters Schiffbau',
      yacht_model: 'Al Mirqab 133m',
    },
  ];

  for (const p of prospects) {
    await client.query(
      `INSERT INTO prospects (name, company, location, heat_tier, notes, yacht_brand, yacht_model, date_added, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, NOW(), NOW())`,
      [p.name, p.company, p.location, p.heat_tier, p.notes, p.yacht_brand, p.yacht_model]
    );
  }

  console.log(`[Migration 010] Replaced demo prospects with ${prospects.length} real UHNWI yacht owners`);
};

exports.down = async (client) => {
  // Remove all UHNWI prospects (re-run 005 to restore demo data if needed)
  await client.query('DELETE FROM prospect_signals WHERE prospect_id IN (SELECT id FROM prospects)');
  await client.query('DELETE FROM scan_history WHERE prospect_id IN (SELECT id FROM prospects)');
  await client.query('DELETE FROM prospects');
  console.log('[Migration 010] Rolled back: removed UHNWI prospects');
};
