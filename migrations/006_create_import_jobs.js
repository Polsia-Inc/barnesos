module.exports = {
  name: '006_create_import_jobs',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS import_jobs (
        id SERIAL PRIMARY KEY,
        status VARCHAR(20) DEFAULT 'processing',
        mode VARCHAR(20) DEFAULT 'replace',
        total_rows INTEGER DEFAULT 0,
        inserted_count INTEGER DEFAULT 0,
        rejected_count INTEGER DEFAULT 0,
        errors JSONB DEFAULT '[]'::jsonb,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
  },
  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS import_jobs');
  }
};
