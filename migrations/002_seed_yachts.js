module.exports = {
  name: '002_seed_yachts',
  up: async (client) => {
    const { rows } = await client.query('SELECT COUNT(*) FROM yachts');
    if (parseInt(rows[0].count) > 0) return;

    const yachts = [
      ['Sanlorenzo', 'SX88', 27.0, 'Ready', 'Italy', 6500000, 'motor', true, 5, 3, 'Well-maintained'],
      ['Benetti', 'Delfino 95', 29.0, '2026 Q2', 'Italy', 8200000, 'motor', false, 0, 4, 'New build'],
      ['Ferretti', '780', 24.0, 'Ready', 'France', 3900000, 'motor', true, 8, 3, 'Owner motivated'],
      ['Azimut', 'Grande 27M', 27.0, 'Ready', 'Monaco', 5200000, 'motor', false, 0, 3, 'Low hours'],
      ['Sunseeker', '95 Yacht', 29.0, '2026 Q1', 'UK', 9800000, 'motor', false, 0, 5, 'Full spec'],
      ['Princess', 'Y85', 26.0, 'Ready', 'Spain', 4500000, 'motor', true, 10, 3, 'Demo boat'],
      ['Riva', '110 Dolcevita', 33.5, '2026 Q3', 'Italy', 14000000, 'motor', false, 0, 4, 'Flagship'],
      ['Mangusta', '130', 40.0, 'Ready', 'Monaco', 18500000, 'motor', true, 3, 5, 'Price reduced'],
      ['Wider', '165', 50.0, '2027 Q1', 'Italy', 28000000, 'motor', false, 0, 4, 'New build'],
      ['Custom Line', '106', 32.0, 'Ready', 'Croatia', 7800000, 'motor', false, 0, 3, 'Charter history'],
      ['Sanlorenzo', 'SD96', 29.5, 'Ready', 'France', 7200000, 'motor', false, 0, 4, 'Semi-displacement'],
      ['Benetti', 'Oasis 40M', 40.0, '2026 Q4', 'Italy', 22000000, 'motor', false, 0, 5, 'Innovative design'],
      ['Ferretti', '920', 28.5, 'Ready', 'Greece', 6800000, 'motor', true, 5, 4, 'Well-equipped'],
      ['Azimut', 'S7', 22.0, 'Ready', 'Italy', 2800000, 'motor', true, 12, 3, 'Entry superyacht'],
      ['Lagoon', 'Seventy 7', 23.0, 'Ready', 'France', 3200000, 'sail', false, 0, 3, 'Power catamaran'],
    ];
    for (const y of yachts) {
      await client.query(
        `INSERT INTO yachts (brand, model, length_m, delivery, location, price_eur, yacht_type, has_discount, discount_pct, broker_commission_pct, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, y
      );
    }
  }
};
