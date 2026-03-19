module.exports = {
  name: '019_yacht_product_url',

  up: async (client) => {
    // Add product_url column to yachts table
    await client.query(`
      ALTER TABLE yachts
        ADD COLUMN IF NOT EXISTS product_url TEXT
    `);
    console.log('[019] yachts: added product_url column');

    // ── Populate known URLs ──────────────────────────────────────────────────
    //
    // Azimut Grande series  →  azimut-yachts.com/en/grande/grande-{slug}
    // Azimut Atlantis       →  azimut-yachts.com/en/atlantis/{slug}-atlantis
    // Azimut Flybridge/S    →  azimut-yachts.com/en/flybridge/{slug}-flybridge
    // Benetti               →  benettiyachts.it/en/yachts/{slug}
    // Riva                  →  riva-yacht.com/en/motorboats/{slug}
    // Custom Line Navetta   →  customline-yacht.com/en/navetta-{num}
    // Custom Line Saetta    →  customline-yacht.com/en/saetta-{num}
    // Mangusta              →  mangusta.it/mangusta-{num}  (or oceano-{num})
    // San Lorenzo SL        →  sanlorenzoyacht.com/en/sl{num}
    // San Lorenzo SD        →  sanlorenzoyacht.com/en/sd{num}
    // San Lorenzo Steel     →  sanlorenzoyacht.com/en/{num}steel
    //
    // Pattern: ILIKE matches are case-insensitive; we match builder + name patterns
    // to construct accurate product page URLs.
    // If no match, product_url stays NULL → image is non-clickable (no broken links).

    // ── Azimut Grande ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.azimut-yachts.com/en/grande/grande-',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Azimut\\s+)?Grande\\s*', '', 'i'),
          '\\s+', '-', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%azimut%'
        AND name ILIKE '%grande%'
        AND product_url IS NULL
    `);

    // ── Azimut Atlantis ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.azimut-yachts.com/en/atlantis/',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Azimut\\s+)?Atlantis\\s*', '', 'i'),
          '\\s+', '-', 'g'
        )),
        '-atlantis/'
      )
      WHERE builder ILIKE '%azimut%'
        AND name ILIKE '%atlantis%'
        AND product_url IS NULL
    `);

    // ── Azimut Flybridge / S series (numeric model) ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.azimut-yachts.com/en/flybridge/',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Azimut\\s+)?', '', 'i'),
          '\\s+', '-', 'g'
        )),
        '-flybridge/'
      )
      WHERE builder ILIKE '%azimut%'
        AND name !~* 'grande|atlantis'
        AND product_url IS NULL
    `);

    // ── Benetti ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.benettiyachts.it/en/yachts/',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Benetti\\s+)?', '', 'i'),
          '[\\s/]+', '-', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%benetti%'
        AND product_url IS NULL
    `);

    // ── Riva ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.riva-yacht.com/en/motorboats/',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Riva\\s+)?', '', 'i'),
          '[\\s\\']+', '-', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%riva%'
        AND product_url IS NULL
    `);

    // ── Custom Line Navetta ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.customline-yacht.com/en/navetta-',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Custom\\s*Line\\s+)?Navetta\\s*', '', 'i'),
          '\\s+', '-', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%custom%line%'
        AND name ILIKE '%navetta%'
        AND product_url IS NULL
    `);

    // ── Custom Line Saetta ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.customline-yacht.com/en/saetta-',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Custom\\s*Line\\s+)?Saetta\\s*', '', 'i'),
          '\\s+', '-', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%custom%line%'
        AND name ILIKE '%saetta%'
        AND product_url IS NULL
    `);

    // ── Custom Line (other models) ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.customline-yacht.com/en/',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Custom\\s*Line\\s+)?', '', 'i'),
          '[\\s/]+', '-', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%custom%line%'
        AND product_url IS NULL
    `);

    // ── Mangusta Oceano ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://mangusta.it/oceano-',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Mangusta\\s+)?Oceano\\s*', '', 'i'),
          '\\s+', '-', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%mangusta%'
        AND name ILIKE '%oceano%'
        AND product_url IS NULL
    `);

    // ── Mangusta (main line) ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://mangusta.it/mangusta-',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(Mangusta\\s+)?', '', 'i'),
          '\\s+', '-', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%mangusta%'
        AND product_url IS NULL
    `);

    // ── San Lorenzo SL series ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.sanlorenzoyacht.com/en/',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(San\\s*Lorenzo\\s+)?', '', 'i'),
          '\\s+', '', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%san%lorenzo%'
        AND (name ILIKE '%SL%' OR name ILIKE '%SD%' OR name ILIKE '%Steel%' OR name ILIKE '%Sport%')
        AND product_url IS NULL
    `);

    // ── San Lorenzo (remaining) ──
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.sanlorenzoyacht.com/en/',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(name, '^(San\\s*Lorenzo\\s+)?', '', 'i'),
          '[\\s/]+', '-', 'g'
        )),
        '/'
      )
      WHERE builder ILIKE '%san%lorenzo%'
        AND product_url IS NULL
    `);

    const { rows } = await client.query(`SELECT COUNT(*) FROM yachts WHERE product_url IS NOT NULL`);
    console.log(`[019] Populated product_url for ${rows[0].count} yachts`);
    console.log('[019] yacht_product_url migration complete');
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE yachts
        DROP COLUMN IF EXISTS product_url
    `);
    console.log('[019] Rolled back yacht_product_url');
  }
};
