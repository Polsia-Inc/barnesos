module.exports = {
  name: '019_yacht_product_url',

  up: async (client) => {
    // Add product_url column to yachts table
    await client.query(`
      ALTER TABLE yachts
        ADD COLUMN IF NOT EXISTS product_url TEXT
    `);
    console.log('[019] yachts: added product_url column');

    // ── Populate brand product page URLs ─────────────────────────────────────
    //
    // Strategy: use REPLACE + LOWER (no REGEXP_REPLACE character classes) to
    // avoid POSIX regex quoting issues. Prefix-stripping uses REGEXP_REPLACE
    // with the 4th 'i' flag for case-insensitive matching (PostgreSQL ARE).
    //
    // If builder/name doesn't match, product_url stays NULL → image is
    // non-clickable in Matchmaker (no broken external links).

    // ── Azimut Grande ──────────────────────────────────────────────────────────
    // e.g. "Grande 30M" → /en/grande/grande-30m/
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.azimut-yachts.com/en/grande/grande-',
        LOWER(REPLACE(
          TRIM(REGEXP_REPLACE(name, '^(Azimut )?Grande ?', '', 'i')),
          ' ', '-'
        )),
        '/'
      )
      WHERE builder ILIKE '%azimut%'
        AND name ILIKE '%grande%'
        AND product_url IS NULL
    `);

    // ── Azimut Atlantis ────────────────────────────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.azimut-yachts.com/en/atlantis/',
        LOWER(REPLACE(
          TRIM(REGEXP_REPLACE(name, '^(Azimut )?Atlantis ?', '', 'i')),
          ' ', '-'
        )),
        '-atlantis/'
      )
      WHERE builder ILIKE '%azimut%'
        AND name ILIKE '%atlantis%'
        AND product_url IS NULL
    `);

    // ── Azimut Flybridge / S / numeric models ──────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.azimut-yachts.com/en/flybridge/',
        LOWER(REPLACE(
          TRIM(REGEXP_REPLACE(name, '^Azimut ?', '', 'i')),
          ' ', '-'
        )),
        '-flybridge/'
      )
      WHERE builder ILIKE '%azimut%'
        AND name NOT ILIKE '%grande%'
        AND name NOT ILIKE '%atlantis%'
        AND product_url IS NULL
    `);

    // ── Benetti ────────────────────────────────────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.benettiyachts.it/en/yachts/',
        LOWER(REPLACE(
          REPLACE(
            TRIM(REGEXP_REPLACE(name, '^Benetti ?', '', 'i')),
            '/', '-'
          ),
          ' ', '-'
        )),
        '/'
      )
      WHERE builder ILIKE '%benetti%'
        AND product_url IS NULL
    `);

    // ── Riva ───────────────────────────────────────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.riva-yacht.com/en/motorboats/',
        LOWER(REPLACE(
          TRIM(REGEXP_REPLACE(name, '^Riva ?', '', 'i')),
          ' ', '-'
        )),
        '/'
      )
      WHERE builder ILIKE '%riva%'
        AND product_url IS NULL
    `);

    // ── Custom Line Navetta ────────────────────────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.customline-yacht.com/en/navetta-',
        LOWER(REPLACE(
          TRIM(REGEXP_REPLACE(name, '^(Custom ?Line )?Navetta ?', '', 'i')),
          ' ', '-'
        )),
        '/'
      )
      WHERE builder ILIKE '%custom%line%'
        AND name ILIKE '%navetta%'
        AND product_url IS NULL
    `);

    // ── Custom Line Saetta ─────────────────────────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.customline-yacht.com/en/saetta-',
        LOWER(REPLACE(
          TRIM(REGEXP_REPLACE(name, '^(Custom ?Line )?Saetta ?', '', 'i')),
          ' ', '-'
        )),
        '/'
      )
      WHERE builder ILIKE '%custom%line%'
        AND name ILIKE '%saetta%'
        AND product_url IS NULL
    `);

    // ── Custom Line (other models) ─────────────────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.customline-yacht.com/en/',
        LOWER(REPLACE(
          REPLACE(
            TRIM(REGEXP_REPLACE(name, '^Custom ?Line ?', '', 'i')),
            '/', '-'
          ),
          ' ', '-'
        )),
        '/'
      )
      WHERE builder ILIKE '%custom%line%'
        AND product_url IS NULL
    `);

    // ── Mangusta Oceano ────────────────────────────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://mangusta.it/oceano-',
        LOWER(REPLACE(
          TRIM(REGEXP_REPLACE(name, '^(Mangusta )?Oceano ?', '', 'i')),
          ' ', '-'
        )),
        '/'
      )
      WHERE builder ILIKE '%mangusta%'
        AND name ILIKE '%oceano%'
        AND product_url IS NULL
    `);

    // ── Mangusta main line ─────────────────────────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://mangusta.it/mangusta-',
        LOWER(REPLACE(
          TRIM(REGEXP_REPLACE(name, '^Mangusta ?', '', 'i')),
          ' ', '-'
        )),
        '/'
      )
      WHERE builder ILIKE '%mangusta%'
        AND product_url IS NULL
    `);

    // ── San Lorenzo (SL / SD / Steel / Sport) ─────────────────────────────────
    // SL102 → /en/sl102/ — no spaces/hyphens needed for pure alphanumeric slugs
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.sanlorenzoyacht.com/en/',
        LOWER(REPLACE(
          TRIM(REGEXP_REPLACE(name, '^(San ?Lorenzo )?', '', 'i')),
          ' ', ''
        )),
        '/'
      )
      WHERE builder ILIKE '%san%lorenzo%'
        AND (
          name ILIKE '%SL%' OR name ILIKE '%SD%' OR
          name ILIKE '%Steel%' OR name ILIKE '%Sport%'
        )
        AND product_url IS NULL
    `);

    // ── San Lorenzo (remaining) ────────────────────────────────────────────────
    await client.query(`
      UPDATE yachts
      SET product_url = CONCAT(
        'https://www.sanlorenzoyacht.com/en/',
        LOWER(REPLACE(
          REPLACE(
            TRIM(REGEXP_REPLACE(name, '^(San ?Lorenzo )?', '', 'i')),
            '/', '-'
          ),
          ' ', '-'
        )),
        '/'
      )
      WHERE builder ILIKE '%san%lorenzo%'
        AND product_url IS NULL
    `);

    const { rows } = await client.query(
      `SELECT COUNT(*) FROM yachts WHERE product_url IS NOT NULL`
    );
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
