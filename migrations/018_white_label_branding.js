module.exports = {
  name: '018_white_label_branding',

  up: async (client) => {
    // Add white-label branding columns to tenants
    await client.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS logo_url TEXT,
        ADD COLUMN IF NOT EXISTS company_display_name VARCHAR(255)
    `);
    console.log('[018] tenants: added logo_url, company_display_name');

    // Ensure primary_color column exists (added in earlier migration but double-check)
    await client.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS primary_color VARCHAR(20)
    `);
    console.log('[018] tenants: ensured primary_color exists');

    console.log('[018] white_label_branding migration complete');
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE tenants
        DROP COLUMN IF EXISTS logo_url,
        DROP COLUMN IF EXISTS company_display_name
    `);
    console.log('[018] Rolled back white_label_branding');
  }
};
