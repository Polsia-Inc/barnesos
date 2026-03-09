module.exports = {
  name: 'seed_yachts',
  up: async (client) => {
    const yachts = [
      { brand: 'Admiral', model: 'S-Force 55 (499GT)', length_m: 55, delivery: '22 months', location: 'Viareggio', price_eur: 35500000, notes: 'Boat equipped. BOTTOM PRICE 28,500,000', has_discount: true, discount_pct: 20, broker_commission_pct: 0 },
      { brand: 'Mengi Yay', model: 'Virtus 52 XP', length_m: 52.4, delivery: 'Spring 2026', location: 'Tuzla, Istanbul', price_eur: 34000000, notes: '28,000,000 for the owner', has_discount: true, discount_pct: 18, broker_commission_pct: 0 },
      { brand: 'Custom Line', model: 'Aluminum 50', length_m: 49.9, delivery: 'Summer 2027', location: 'Ancona', price_eur: 38400000, notes: 'Base price + approx 10-15% optional', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Mangusta', model: '165 Rev', length_m: 49.9, delivery: 'May 2027', location: 'Viareggio', price_eur: 35500000, notes: 'Boat equipped with price list', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Benetti', model: 'Custom B.Yond 47m', length_m: 47, delivery: 'June 2026', location: 'Livorno', price_eur: 43000000, notes: 'Boat equipped with price list. Contact INIGO for max discount', has_discount: true, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Azimut', model: 'Grande 44 (New Model)', length_m: 44, delivery: 'Summer 2028', location: 'Viareggio', price_eur: 25500000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Custom Line', model: 'Saetta 140', length_m: 42, delivery: 'Summer 2026', location: 'Ancona', price_eur: 25869645, notes: 'Boat equipped with price list', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Custom Line', model: 'Saetta 140', length_m: 42, delivery: 'Summer 2027', location: 'Ancona', price_eur: 22850000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Custom Line', model: 'Navetta 42', length_m: 41.8, delivery: 'Summer 2027', location: 'Ancona', price_eur: 20500000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Riva', model: "130' Bellissima", length_m: 40, delivery: 'June 2027', location: 'La Spezia', price_eur: 19650000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Custom Line', model: 'Saetta 128 (New Model)', length_m: 39.8, delivery: 'Fall 2026', location: 'Ancona', price_eur: 21597430, notes: 'Boat equipped with price list', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Next Group', model: 'AB 130', length_m: 39.65, delivery: 'April 2027', location: 'Viareggio', price_eur: 18700000, notes: 'Base price + approx 10-15% optional. 15% discount customer, 5% broker commission', has_discount: true, discount_pct: 15, broker_commission_pct: 5 },
      { brand: 'Mangusta', model: 'Oceano 39', length_m: 39.2, delivery: 'June 2027', location: 'Viareggio', price_eur: 23100000, notes: 'Boat equipped with price list', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Custom Line', model: 'Navetta 38', length_m: 38.76, delivery: 'Fall 2027', location: 'Ancona', price_eur: 17200000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Azimut', model: 'Grande Trideck 38.5', length_m: 38.5, delivery: 'Summer 2027', location: 'Viareggio', price_eur: 18200000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Custom Line', model: 'Saetta 120 American Pack', length_m: 38, delivery: 'Ready', location: 'Miami', price_eur: 18400000, notes: 'Boat equipped with price list. Miami display', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Next Group', model: 'Maiora M 38', length_m: 37.18, delivery: 'January 2027', location: 'Viareggio', price_eur: 15800000, notes: 'Base price + approx 10-15% optional. 15% discount customer, 5% broker commission', has_discount: true, discount_pct: 15, broker_commission_pct: 5 },
      { brand: 'Benetti', model: 'Motopanfilo 37', length_m: 37, delivery: 'July 2026', location: 'Viareggio', price_eur: 21070000, notes: 'Boat equipped with price list. 20% discount customer, 5% broker commission', has_discount: true, discount_pct: 20, broker_commission_pct: 5 },
      { brand: 'Next Group', model: 'Maiora 36 Exuma', length_m: 36.9, delivery: 'June 2026', location: 'Viareggio', price_eur: 20800000, notes: 'Boat equipped with price list. 15% discount customer, 5% broker commission', has_discount: true, discount_pct: 15, broker_commission_pct: 5 },
      { brand: 'Azimut', model: 'Grande 36', length_m: 36, delivery: 'Spring 2026', location: 'Viareggio', price_eur: 19920000, notes: 'Boat equipped with price list', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Custom Line', model: 'Navetta 35 (New Model)', length_m: 34.5, delivery: 'Spring 2027', location: 'Ancona', price_eur: 19274400, notes: 'Boat equipped with price list', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Custom Line', model: 'Navetta 35 (New Model)', length_m: 34.5, delivery: 'Summer 2027', location: 'Ancona', price_eur: 14850000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Benetti', model: 'Oasis 34', length_m: 34, delivery: 'June 2027', location: 'Viareggio', price_eur: 17500000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Next Group', model: 'AB 110', length_m: 33.7, delivery: 'Ready', location: 'Viareggio', price_eur: 15600000, notes: 'Boat equipped with price list. 15% discount customer, 5% broker commission', has_discount: true, discount_pct: 15, broker_commission_pct: 5 },
      { brand: 'Custom Line', model: 'Navetta 33', length_m: 33, delivery: 'Ready', location: 'Ancona', price_eur: 16313105, notes: 'Boat equipped with price list. 19% discount customer, 5% broker commission', has_discount: true, discount_pct: 19, broker_commission_pct: 5 },
      { brand: 'Custom Line', model: 'Saetta 106 x2', length_m: 32.8, delivery: 'Ready', location: 'Ancona', price_eur: 13531700, notes: 'Boat equipped with price list. 18% discount customer, 5% broker commission', has_discount: true, discount_pct: 18, broker_commission_pct: 5 },
      { brand: 'Mangusta', model: '104 Rev', length_m: 31.8, delivery: 'October 2026', location: 'Viareggio', price_eur: 13100000, notes: 'Boat equipped with price list', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Riva', model: "102' Corsaro Super", length_m: 31, delivery: 'November 2026', location: 'La Spezia', price_eur: 10840000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Riva', model: "102' Corsaro Super", length_m: 31, delivery: 'June 2027', location: 'La Spezia', price_eur: 10840000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Next Group', model: 'Maiora M 30', length_m: 30.4, delivery: 'Summer 2027', location: 'Viareggio', price_eur: 10600000, notes: 'Base price + approx 10-15% optional. 15% discount customer, 5% broker commission', has_discount: true, discount_pct: 15, broker_commission_pct: 5 },
      { brand: 'Azimut', model: 'Grande 30', length_m: 30, delivery: 'Summer 2027', location: 'Viareggio', price_eur: 12480000, notes: 'Boat equipped with price list', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Azimut', model: 'Magellano 30', length_m: 30, delivery: 'Winter 2026', location: 'Viareggio', price_eur: 10900000, notes: 'Base price. Miami display', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Next Group', model: 'AB 95', length_m: 28.45, delivery: 'Ready', location: 'Viareggio', price_eur: 11900000, notes: 'SOLD - USA private client at 9,900,000 (16% discount)', has_discount: true, discount_pct: 16, broker_commission_pct: 0, is_available: false },
      { brand: 'Next Group', model: 'AB 95 S', length_m: 28.45, delivery: 'Ready', location: 'Viareggio', price_eur: 11900000, notes: 'Boat equipped with price list. 15% discount customer, 5% broker commission', has_discount: true, discount_pct: 15, broker_commission_pct: 5 },
      { brand: 'Custom Line', model: 'Navetta 30', length_m: 28.43, delivery: 'Fall 2026', location: 'Ancona', price_eur: 12225880, notes: 'Boat equipped with price list', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Wider Yacht', model: 'Wider Cat 92', length_m: 27.39, delivery: 'December 2026', location: 'Fano', price_eur: 13200000, notes: 'Boat equipped with price list. 12% discount customer, 5% broker commission', has_discount: true, discount_pct: 12, broker_commission_pct: 5 },
      { brand: 'Azimut', model: 'Grande 27', length_m: 27, delivery: 'Ready', location: 'Viareggio', price_eur: 8048000, notes: 'Boat equipped with price list. 20% discount customer, 5% broker commission', has_discount: true, discount_pct: 20, broker_commission_pct: 5 },
      { brand: 'Azimut', model: 'Magellano 27 (New Model)', length_m: 27, delivery: 'Winter 2026', location: 'Viareggio', price_eur: 8500000, notes: 'Base price', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Azimut', model: 'Grande 26', length_m: 26, delivery: 'Ready', location: 'Viareggio', price_eur: 7900000, notes: 'Boat equipped with price list. 23% discount customer, 5% broker commission. Miami display', has_discount: true, discount_pct: 23, broker_commission_pct: 5 },
      { brand: 'Azimut', model: 'Grande 26', length_m: 26, delivery: 'Ready', location: 'Viareggio', price_eur: 7782000, notes: 'Boat equipped with price list. 23% discount customer, 5% broker commission', has_discount: true, discount_pct: 23, broker_commission_pct: 5 },
      { brand: 'Next Group', model: 'AB 80', length_m: 25.4, delivery: 'Ready', location: 'Viareggio', price_eur: 9100000, notes: 'Boat equipped with price list. Net amount to builder: 6,500,000', has_discount: true, discount_pct: 29, broker_commission_pct: 0 },
      { brand: 'Comar Yacht', model: 'C.Cat 80', length_m: 24, delivery: '24 months', location: 'Roma', price_eur: 10000000, notes: 'Base price + approx 15% optional. 8% broker commission', has_discount: false, discount_pct: 0, broker_commission_pct: 8, yacht_type: 'catamaran' },
      { brand: 'Picchiotti', model: 'Gentleman 24 Aluminum', length_m: 24, delivery: 'Ready', location: 'La Spezia', price_eur: 8900000, notes: 'BOTTOM PRICE 5,500,000. 5% broker commission', has_discount: true, discount_pct: 38, broker_commission_pct: 5 },
      { brand: 'Wider Yacht', model: 'Wider Cat 76', length_m: 23.12, delivery: '6 months', location: 'Fano', price_eur: 8300000, notes: 'Boat equipped with price list. 12% discount customer, 5% broker commission', has_discount: true, discount_pct: 12, broker_commission_pct: 5 },
      { brand: 'Comar Yacht', model: 'C-Cat 65 Carbon', length_m: 21, delivery: 'Summer 2027', location: 'Roma', price_eur: 5000000, notes: 'Base price + approx 10% optional. 8% broker commission', has_discount: false, discount_pct: 0, broker_commission_pct: 8, yacht_type: 'catamaran' },
      { brand: 'Comar Yacht', model: 'C-Cat 65 Fiberglass', length_m: 21, delivery: 'Summer 2027', location: 'Roma', price_eur: 3800000, notes: 'Base price + approx 15% optional. 8% broker commission', has_discount: false, discount_pct: 0, broker_commission_pct: 8, yacht_type: 'catamaran' },
      { brand: 'Tecnomar', model: 'Lamborghini 63', length_m: 20, delivery: 'Ready', location: 'La Spezia', price_eur: 5000000, notes: 'SOLD at 4,000,000', has_discount: true, discount_pct: 20, broker_commission_pct: 0, is_available: false },
      { brand: 'Tecnomar', model: 'Lamborghini 63 White & Blu', length_m: 20, delivery: 'Ready', location: 'La Spezia', price_eur: 4800000, notes: 'Boat equipped with price list. 18% discount customer, 10% broker commission', has_discount: true, discount_pct: 18, broker_commission_pct: 10 },
      { brand: 'Prestige', model: 'M8', length_m: 19.82, delivery: 'June 2026', location: 'Monfalcone', price_eur: 5687975, notes: '', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Prestige', model: 'M7', length_m: 17.94, delivery: 'May 2026', location: 'Monfalcone', price_eur: 4582710, notes: '', has_discount: false, discount_pct: 0, broker_commission_pct: 0 },
      { brand: 'Blu Martin', model: 'Walk Around 46', length_m: 14, delivery: 'June 2026', location: 'Como', price_eur: 912360, notes: 'Boat equipped with price list. 25% total discount', has_discount: true, discount_pct: 25, broker_commission_pct: 0 },
    ];

    for (const y of yachts) {
      await client.query(
        `INSERT INTO yachts (brand, model, length_m, delivery, location, price_eur, notes, has_discount, discount_pct, broker_commission_pct, yacht_type, is_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          y.brand, y.model, y.length_m, y.delivery, y.location, y.price_eur,
          y.notes, y.has_discount, y.discount_pct, y.broker_commission_pct,
          y.yacht_type || 'motor', y.is_available !== false
        ]
      );
    }

    console.log(`Seeded ${yachts.length} yachts`);
  }
};
