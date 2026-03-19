module.exports = {
  name: '020_add_is_demo_to_prospects',

  up: async (client) => {
    // Add is_demo column — defaults to false for all future prospects
    await client.query(`
      ALTER TABLE prospects
        ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE
    `);
    console.log('[020] prospects: added is_demo column');

    // Mark every prospect that exists right now as a demo prospect.
    // At the time this migration runs the only prospects in the DB are the
    // 23 seeded UHNWI placeholders inserted by migration 010 and any
    // additional demo contacts added since launch.  All real user-imported
    // prospects will be inserted after this migration runs and will receive
    // the default value of FALSE automatically.
    const { rowCount } = await client.query(`
      UPDATE prospects SET is_demo = TRUE WHERE is_demo = FALSE
    `);
    console.log(`[020] Marked ${rowCount} existing prospect(s) as is_demo = true`);
    console.log('[020] add_is_demo_to_prospects migration complete');
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE prospects DROP COLUMN IF EXISTS is_demo
    `);
    console.log('[020] Rolled back: removed is_demo column from prospects');
  }
};
