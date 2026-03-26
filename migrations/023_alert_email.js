module.exports = {
  name: '023_alert_email',

  up: async (client) => {
    // Add alert_email to tenants for tier-change email notifications
    await client.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS alert_email VARCHAR(255)
    `);
    console.log('[023] tenants: added alert_email column for tier-change alerts');
  },

  down: async (client) => {
    await client.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS alert_email`);
    console.log('[023] Rolled back: removed alert_email from tenants');
  }
};
