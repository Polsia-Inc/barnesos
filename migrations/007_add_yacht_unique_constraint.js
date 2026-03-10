module.exports = {
  name: '007_add_yacht_unique_constraint',
  up: async (client) => {
    // Remove any duplicate brand+model combos before adding constraint
    await client.query(`
      DELETE FROM yachts a USING yachts b
      WHERE a.id < b.id
        AND a.brand = b.brand
        AND a.model IS NOT DISTINCT FROM b.model
    `);
    await client.query(`
      ALTER TABLE yachts
      ADD CONSTRAINT IF NOT EXISTS yachts_brand_model_unique
      UNIQUE (brand, model)
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE yachts DROP CONSTRAINT IF EXISTS yachts_brand_model_unique
    `);
  }
};
