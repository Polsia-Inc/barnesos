module.exports = {
  name: '008_create_outreach_emails',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS outreach_emails (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        template_type VARCHAR(50) NOT NULL,
        subject VARCHAR(500) NOT NULL,
        body TEXT NOT NULL,
        sent_from VARCHAR(100) DEFAULT 'barnesos@polsia.app',
        sent_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_outreach_emails_prospect_id ON outreach_emails(prospect_id)
    `);
  }
};
