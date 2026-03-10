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
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'yachts_brand_model_unique'
        ) THEN
          ALTER TABLE yachts ADD CONSTRAINT yachts_brand_model_unique UNIQUE (brand, model);
        END IF;
      END $$
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE yachts DROP CONSTRAINT IF EXISTS yachts_brand_model_unique
    `);
  }
};
