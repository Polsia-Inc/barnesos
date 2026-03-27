/**
 * verify-matchmaker.js
 * Tests the /api/yachts/filters DB queries directly.
 */
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  console.log('Testing /api/yachts/filters DB queries...\n');

  try {
    const [builders, currencies, locations, rangeStats, brokerRows] = await Promise.all([
      pool.query(`SELECT DISTINCT builder FROM yachts WHERE builder IS NOT NULL AND is_active = TRUE ORDER BY builder`),
      pool.query(`SELECT DISTINCT currency FROM yachts WHERE currency IS NOT NULL AND is_active = TRUE ORDER BY currency`),
      pool.query(`SELECT DISTINCT location_text FROM yachts WHERE location_text IS NOT NULL AND is_active = TRUE ORDER BY location_text`),
      pool.query(`SELECT MIN(price) as min_price, MAX(price) as max_price, COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = TRUE) as active, COUNT(*) FILTER (WHERE is_approved = TRUE) as approved FROM yachts`),
      pool.query(`SELECT DISTINCT TRIM(unnest(string_to_array(brokers, ','))) as broker FROM yachts WHERE brokers IS NOT NULL AND brokers != '' ORDER BY broker`)
    ]);

    const response = {
      success: true,
      builders: builders.rows.map(r => r.builder),
      currencies: currencies.rows.map(r => r.currency),
      locations: locations.rows.map(r => r.location_text),
      brokers: brokerRows.rows.map(r => r.broker).filter(Boolean),
      stats: rangeStats.rows[0]
    };

    console.log('✅ API would return:');
    console.log('  builders count:', response.builders.length);
    console.log('  builders:', response.builders);
    console.log('  locations count:', response.locations.length);
    console.log('  locations:', response.locations);
    console.log('  stats:', response.stats);
    console.log('  success:', response.success);
    console.log('\n✅ The /api/yachts/filters API should return data correctly.');

  } catch (err) {
    console.error('❌ Query failed:', err.message);
  } finally {
    await pool.end();
  }
}

main();
