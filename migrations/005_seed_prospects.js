module.exports = {
  name: '005_seed_prospects',
  up: async (client) => {
    const { rows } = await client.query('SELECT COUNT(*) FROM prospects');
    if (parseInt(rows[0].count) > 0) return;

    const prospects = [
      // Format: [name, email, phone, company, location, yacht_interest, yacht_brand, yacht_model, notes, commercial_contact]
      ['Alexander Rostov', 'a.rostov@rstcapital.com', '+44 7911 234567', 'RST Capital Partners', 'London, UK', 'Looking for 40m+ explorer yacht', 'Wider', '165', 'Russian-British investor. Recently sold fintech portfolio. Active Monaco YC member.', 'Bruno Delahaye'],
      ['Jean-Marc Duval', 'jm.duval@duvalholdings.fr', '+33 6 12 34 56 78', 'Duval Holdings SA', 'Paris, France', 'Interested in Benetti custom 47m', 'Benetti', 'B.Yond 47m', 'French industrialist. Current owner of 30m Sunseeker. Looking to upgrade.', 'Bruno Delahaye'],
      ['Khalid Al-Rashid', 'kalrashid@arabicinvest.ae', '+971 50 123 4567', 'Arabic Investment Group', 'Dubai, UAE', 'Custom 50m+ superyacht', 'Custom Line', 'Aluminum 50', 'UAE family office. Multiple yacht owner. Prefers Italian builders.', 'Bruno Delahaye'],
      ['Marco Bernardini', 'marco@bernardini-group.it', '+39 335 123 4567', 'Bernardini Group SpA', 'Milan, Italy', 'Mangusta 165 Rev', 'Mangusta', '165 Rev', 'Italian shipping magnate. Close relationship with Viareggio yards.', 'Bruno Delahaye'],
      ['Thomas Hartmann', 'thartmann@hartmann-capital.de', '+49 170 1234567', 'Hartmann Capital GmbH', 'Munich, Germany', 'Azimut Grande 44m', 'Azimut', 'Grande 44', 'German tech investor. First yacht buyer. Budget 25-30M EUR.', 'Bruno Delahaye'],
      ['Viktor Petrov', 'vpetrov@petrovcorp.com', '+7 916 123 4567', 'Petrov Corporation', 'Moscow, Russia', '50m+ new build', 'Admiral', 'S-Force 55', 'Energy sector. Interested in Admiral S-Force 55. Price sensitive.', 'Bruno Delahaye'],
      ['Charles Wellington III', 'cwellington@wellingtonfund.com', '+1 212 555 0134', 'Wellington Family Fund', 'New York, USA', 'Benetti Oasis 34m', 'Benetti', 'Oasis 34', 'Wall Street fund manager. Summer Med cruiser. First-time superyacht buyer.', 'Bruno Delahaye'],
      ['Pierre Lefèvre', 'plefevre@lefevre-shipping.mc', '+377 93 12 34 56', 'Lefèvre Maritime', 'Monaco', 'Riva 130 Bellissima', 'Riva', '130 Bellissima', 'Monaco resident. Current Riva 88 owner. Brand loyal.', 'Bruno Delahaye'],
      ['Sven Johansson', 'sven@johansson-invest.se', '+46 70 123 4567', 'Johansson Investments', 'Stockholm, Sweden', 'Explorer yacht 40m+', 'Wider', 'Cat 92', 'Swedish tech entrepreneur. Sold SaaS company. Wants eco-friendly yacht.', 'Bruno Delahaye'],
      ['Abdullah bin Faisal', 'abf@royalcapital.sa', '+966 55 123 4567', 'Royal Capital Holdings', 'Riyadh, Saudi Arabia', '55m custom superyacht', 'Mengi Yay', 'Virtus 52 XP', 'Saudi royal family member. Looking for modern design. Privacy priority.', 'Bruno Delahaye'],
      ['Robert Chen', 'rchen@pacificventures.hk', '+852 9123 4567', 'Pacific Ventures Ltd', 'Hong Kong', 'Azimut Grande Trideck', 'Azimut', 'Grande Trideck', 'Hong Kong real estate developer. Wants Asia-capable yacht.', 'Bruno Delahaye'],
      ['Elena Vasilieva', 'evasilieva@vasilieva-art.com', '+44 7700 123456', 'Vasilieva Art Foundation', 'London, UK', 'Custom Line Navetta 42', 'Custom Line', 'Navetta 42', 'Art collector and philanthropist. Wants gallery-quality interior.', 'Bruno Delahaye'],
      ['Giovanni Morosini', 'gmorosini@morosinigroup.it', '+39 348 123 4567', 'Morosini Industrial Group', 'Venice, Italy', 'Custom Line Saetta 140', 'Custom Line', 'Saetta 140', 'Italian manufacturing family. Existing client. Upgrading from 32m.', 'Bruno Delahaye'],
      ['James Blackwood', 'jblackwood@blackwoodpe.com', '+1 310 555 0198', 'Blackwood Private Equity', 'Los Angeles, USA', 'Mangusta 104 Rev', 'Mangusta', '104 Rev', 'LA-based PE partner. Wants Miami-deliverable yacht. Fast cruiser preferred.', 'Bruno Delahaye'],
      ['Philippe de Montfort', 'pdm@montfort-capital.ch', '+41 79 123 4567', 'Montfort Capital SA', 'Geneva, Switzerland', 'Benetti Motopanfilo 37', 'Benetti', 'Motopanfilo 37', 'Swiss banker. Classic yacht enthusiast. Values heritage brands.', 'Bruno Delahaye'],
      ['Nasser Al-Thani', 'nthani@thaniinvest.qa', '+974 5512 3456', 'Thani Investment Authority', 'Doha, Qatar', '45m+ custom build', 'Benetti', 'Custom B.Yond 47m', 'Qatari investor. Fleet buyer - already owns 3 yachts. Wants new flagship.', 'Bruno Delahaye'],
      ['Dmitri Volkov', 'dvolkov@volkovcap.com', '+357 96 123456', 'Volkov Capital', 'Limassol, Cyprus', 'Next Group AB 130', 'Next Group', 'AB 130', 'Cyprus-based Russian businessman. Interested in sport yachts.', 'Bruno Delahaye'],
      ['Sarah Mitchell-Park', 'smitchell@parkventures.com.au', '+61 4 1234 5678', 'Park Ventures', 'Sydney, Australia', 'Wider Cat 92', 'Wider Yacht', 'Cat 92', 'Australian mining heiress. Wants catamaran for Pacific cruising.', 'Bruno Delahaye'],
      ['Hans-Peter Weber', 'hpweber@weber-industries.de', '+49 151 1234567', 'Weber Industries AG', 'Frankfurt, Germany', 'Azimut Grande 30', 'Azimut', 'Grande 30', 'German industrialist. Conservative buyer. Wants proven brand.', 'Bruno Delahaye'],
      ['Lorenzo Conti', 'lconti@contifinance.it', '+39 366 123 4567', 'Conti Finance SRL', 'Rome, Italy', 'Custom Line Navetta 35', 'Custom Line', 'Navetta 35', 'Roman banker. Weekend Sardinia cruiser. Wants quiet displacement hull.', 'Bruno Delahaye'],
      ['Richard Ashworth', 'rashworth@ashworthgroup.co.uk', '+44 7891 234567', 'Ashworth Group PLC', 'London, UK', 'Sunseeker 95 Yacht', 'Sunseeker', '95 Yacht', 'British property developer. Brand preference for British builders.', 'Bruno Delahaye'],
      ['Maximilian von Braun', 'mvbraun@braunventures.at', '+43 660 1234567', 'Braun Ventures', 'Vienna, Austria', 'Riva 102 Corsaro Super', 'Riva', '102 Corsaro Super', 'Austrian tech investor. Wants sporty performance yacht.', 'Bruno Delahaye'],
      ['Ahmed bin Salman', 'asalman@gulfholdings.ae', '+971 56 789 0123', 'Gulf Holdings Corp', 'Abu Dhabi, UAE', 'Admiral S-Force 55', 'Admiral', 'S-Force 55', 'Abu Dhabi royal family. Budget no object. Wants largest available.', 'Bruno Delahaye'],
      ['François Beaumont', 'fbeaumont@beaumont-luxe.fr', '+33 6 98 76 54 32', 'Beaumont Luxury Group', 'Cannes, France', 'Next Group Maiora M 38', 'Next Group', 'Maiora M 38', 'French luxury brand owner. Based in Cannes. Knows the Med market well.', 'Bruno Delahaye'],
      ['William Barrett', 'wbarrett@barrettcap.com', '+1 917 555 0167', 'Barrett Capital Management', 'Greenwich, USA', 'Azimut Magellano 30', 'Azimut', 'Magellano 30', 'CT hedge fund manager. Wants explorer-style for Caribbean winters.', 'Bruno Delahaye'],
      ['Sergei Kuznetsov', 'skuznetsov@kuznetsovgroup.ru', '+7 926 123 4567', 'Kuznetsov Group', 'St. Petersburg, Russia', 'Custom Line Saetta 120', 'Custom Line', 'Saetta 120', 'Russian commodities trader. Wants Miami delivery. Urgent timeline.', 'Bruno Delahaye'],
      ['Takeshi Yamamoto', 'tyamamoto@yamamoto-corp.jp', '+81 90 1234 5678', 'Yamamoto Corporation', 'Tokyo, Japan', 'Azimut Grande 27', 'Azimut', 'Grande 27', 'Japanese tech CEO. Entry-level superyacht. Summer Med charter converts.', 'Bruno Delahaye'],
      ['Oscar Lindgren', 'olindgren@lindgren-shipping.no', '+47 91 23 45 67', 'Lindgren Shipping AS', 'Oslo, Norway', 'Wider Cat 76', 'Wider Yacht', 'Cat 76', 'Norwegian shipping family. Eco-conscious. Wants hybrid propulsion.', 'Bruno Delahaye'],
      ['Patrick OConnor', 'poconnor@oconnor-invest.ie', '+353 87 123 4567', 'OConnor Investment Partners', 'Dublin, Ireland', 'Prestige M8', 'Prestige', 'M8', 'Irish tech millionaire. First yacht. Budget 5-6M EUR.', 'Bruno Delahaye'],
      ['Nikolaos Papadopoulos', 'npapadopoulos@aegeangroup.gr', '+30 694 123 4567', 'Aegean Shipping Group', 'Athens, Greece', 'Custom Line Navetta 33', 'Custom Line', 'Navetta 33', 'Greek shipping heir. Knows yachts well. Tough negotiator.', 'Bruno Delahaye'],
      ['David Goldstein', 'dgoldstein@goldsteincap.com', '+1 305 555 0145', 'Goldstein Capital LLC', 'Miami, USA', 'Tecnomar Lamborghini 63', 'Tecnomar', 'Lamborghini 63', 'Miami-based VC. Wants statement yacht. Speed and design priority.', 'Bruno Delahaye'],
      ['Luca Ferrero', 'lferrero@ferrero-holding.it', '+39 347 123 4567', 'Ferrero Holding SpA', 'Turin, Italy', 'Next Group AB 95 S', 'Next Group', 'AB 95 S', 'Italian food industry heir. Sports yacht enthusiast. Regular Monaco shows.', 'Bruno Delahaye'],
      ['Henrik Sørensen', 'hsorensen@sorensen-group.dk', '+45 20 12 34 56', 'Sørensen Group A/S', 'Copenhagen, Denmark', 'Azimut Grande 26', 'Azimut', 'Grande 26', 'Danish pharma executive. Looking for Med-based yacht. Values discount.', 'Bruno Delahaye'],
      ['Miguel Santos', 'msantos@santos-capital.pt', '+351 91 234 5678', 'Santos Capital SGPS', 'Lisbon, Portugal', 'Custom Line Navetta 30', 'Custom Line', 'Navetta 30', 'Portuguese real estate mogul. Wants Algarve/Med cruiser.', 'Bruno Delahaye'],
      ['Klaus Fischer', 'kfischer@fischer-tech.de', '+49 172 1234567', 'Fischer Technology GmbH', 'Hamburg, Germany', 'Prestige M7', 'Prestige', 'M7', 'German tech founder. Budget-conscious. First yacht purchase.', 'Bruno Delahaye'],
      ['Andrei Popov', 'apopov@popovholdings.com', '+971 52 123 4567', 'Popov Holdings Ltd', 'Dubai, UAE', 'Next Group AB 80', 'Next Group', 'AB 80', 'Dubai-based Russian investor. Looking for sport cruiser.', 'Bruno Delahaye'],
      ['Benedict Harrington', 'bharrington@harringtonwealth.com', '+44 7712 345678', 'Harrington Wealth Mgmt', 'London, UK', 'Picchiotti Gentleman 24', 'Picchiotti', 'Gentleman 24', 'British wealth manager. Boutique yacht preference. Values exclusivity.', 'Bruno Delahaye'],
      ['Fernando Alvarez', 'falvarez@alvarez-group.mx', '+52 55 1234 5678', 'Alvarez Group SA', 'Mexico City, Mexico', 'Azimut Magellano 27', 'Azimut', 'Magellano 27', 'Mexican telecom mogul. Wants Caribbean-ready yacht. First-time buyer.', 'Bruno Delahaye'],
      ['Stefan Müller', 'smuller@muller-invest.ch', '+41 78 123 4567', 'Müller Investment AG', 'Zurich, Switzerland', 'Custom Line Saetta 128', 'Custom Line', 'Saetta 128', 'Swiss private equity. Wants fall 2026 delivery. Performance focused.', 'Bruno Delahaye'],
      ['Rajesh Kapoor', 'rkapoor@kapoor-industries.in', '+91 98765 43210', 'Kapoor Industries Ltd', 'Mumbai, India', 'Azimut Grande 36', 'Azimut', 'Grande 36', 'Indian industrialist. Growing interest in yachting. Prefers Italian design.', 'Bruno Delahaye'],
      ['George Papadakis', 'gpapadakis@hellenicmarine.gr', '+30 697 123 4567', 'Hellenic Marine Corp', 'Piraeus, Greece', 'Benetti Oasis 34', 'Benetti', 'Oasis 34', 'Greek maritime family. Second yacht purchase. Summer Aegean cruising.', 'Bruno Delahaye'],
      ['Carlos Mendes', 'cmendes@mendesgroup.br', '+55 11 98765 4321', 'Mendes Group SA', 'São Paulo, Brazil', 'Mangusta Oceano 39', 'Mangusta', 'Oceano 39', 'Brazilian agribusiness billionaire. Wants Med-capable explorer.', 'Bruno Delahaye'],
      ['Edward Worthington', 'eworthington@worthingtonfamily.com', '+1 617 555 0189', 'Worthington Family Office', 'Boston, USA', 'Next Group Maiora 36 Exuma', 'Next Group', 'Maiora 36 Exuma', 'Old money Boston family. Charter-to-own philosophy. Tax optimization focus.', 'Bruno Delahaye'],
      ['Yusuf Al-Maktoum', 'ymaktoum@maktoumcapital.ae', '+971 50 987 6543', 'Maktoum Capital', 'Dubai, UAE', 'Custom Line Aluminum 50', 'Custom Line', 'Aluminum 50', 'Dubai developer. Wants aluminum hull for durability. Budget flexible.', 'Bruno Delahaye'],
      ['Antonio Rossi', 'arossi@rossifashion.it', '+39 340 123 4567', 'Rossi Fashion House', 'Florence, Italy', 'Blu Martin Walk Around 46', 'Blu Martin', 'Walk Around 46', 'Italian fashion designer. Wants day boat for Amalfi Coast. Fun buyer.', 'Bruno Delahaye'],
    ];

    for (const [name, email, phone, company, location, interest, brand, model, notes, contact] of prospects) {
      await client.query(
        `INSERT INTO prospects (name, email, phone, company, location, current_yacht_interest, yacht_brand, yacht_model, notes, commercial_contact)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [name, email, phone, company, location, interest, brand, model, notes, contact]
      );
    }
  }
};
