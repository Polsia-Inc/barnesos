const crypto = require('crypto');

/**
 * Synchronously hash a password using scrypt (for seeding only)
 * Runtime code uses async version in server.js
 */
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

module.exports = {
  name: '014_multi_tenant_saas',

  up: async (client) => {
    // ─── TENANTS ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(255) NOT NULL,
        slug          VARCHAR(100) NOT NULL UNIQUE,
        logo_url      TEXT,
        primary_color VARCHAR(20)  DEFAULT '#0f172a',
        plan          VARCHAR(50)  DEFAULT 'broker',
        status        VARCHAR(20)  DEFAULT 'active'
                      CHECK (status IN ('active','suspended','cancelled')),
        created_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug)`);
    console.log('[014] tenants: created');

    // ─── BROKER USERS ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS broker_users (
        id            SERIAL PRIMARY KEY,
        tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email         VARCHAR(255) NOT NULL,
        password_hash TEXT,
        role          VARCHAR(20)  DEFAULT 'broker'
                      CHECK (role IN ('admin','broker')),
        status        VARCHAR(20)  DEFAULT 'active'
                      CHECK (status IN ('active','invited','disabled')),
        first_name    VARCHAR(100),
        last_name     VARCHAR(100),
        last_login_at TIMESTAMPTZ,
        created_at    TIMESTAMPTZ  DEFAULT NOW(),
        UNIQUE(tenant_id, email)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_broker_users_tenant ON broker_users(tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_broker_users_email ON broker_users(email)`);
    console.log('[014] broker_users: created');

    // ─── INVITE TOKENS ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS broker_invites (
        id          SERIAL PRIMARY KEY,
        tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email       VARCHAR(255) NOT NULL,
        role        VARCHAR(20)  DEFAULT 'broker'
                    CHECK (role IN ('admin','broker')),
        token       VARCHAR(128) NOT NULL UNIQUE,
        invited_by  INTEGER REFERENCES broker_users(id) ON DELETE SET NULL,
        accepted_at TIMESTAMPTZ,
        expires_at  TIMESTAMPTZ  DEFAULT (NOW() + INTERVAL '7 days'),
        created_at  TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_broker_invites_token ON broker_invites(token)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_broker_invites_tenant ON broker_invites(tenant_id)`);
    console.log('[014] broker_invites: created');

    // ─── ROW-LEVEL SECURITY ──────────────────────────────────────────────────
    // Enable RLS on tenant-scoped tables
    await client.query(`ALTER TABLE broker_users ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE broker_invites ENABLE ROW LEVEL SECURITY`);

    // Policy: service role (our app with BYPASSRLS or app_tenant_id setting) can see own tenant rows
    // We implement tenant isolation at the application layer via tenant_id scoping,
    // and also add RLS policies for defence-in-depth.
    //
    // Application sets: SET LOCAL app.tenant_id = '<id>' inside transactions.
    // Rows are only visible when tenant_id matches.

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policy
          WHERE polname = 'broker_users_tenant_isolation'
            AND polrelid = 'broker_users'::regclass
        ) THEN
          CREATE POLICY broker_users_tenant_isolation ON broker_users
            USING (
              tenant_id = COALESCE(
                current_setting('app.tenant_id', true)::integer,
                tenant_id
              )
            );
        END IF;
      END $$
    `);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policy
          WHERE polname = 'broker_invites_tenant_isolation'
            AND polrelid = 'broker_invites'::regclass
        ) THEN
          CREATE POLICY broker_invites_tenant_isolation ON broker_invites
            USING (
              tenant_id = COALESCE(
                current_setting('app.tenant_id', true)::integer,
                tenant_id
              )
            );
        END IF;
      END $$
    `);

    console.log('[014] RLS: enabled on broker_users and broker_invites');

    // ─── DEMO TENANT SEED ────────────────────────────────────────────────────
    const demoPasswordHash = hashPasswordSync('BarnesDemo2024!');

    await client.query(`
      INSERT INTO tenants (name, slug, primary_color, plan)
      VALUES ('Barnes Yachting Demo', 'barnes-demo', '#0f172a', 'broker')
      ON CONFLICT (slug) DO NOTHING
    `);

    const tenantRes = await client.query(
      `SELECT id FROM tenants WHERE slug = 'barnes-demo'`
    );
    const tenantId = tenantRes.rows[0]?.id;

    if (tenantId) {
      await client.query(`
        INSERT INTO broker_users (tenant_id, email, password_hash, role, first_name, last_name, status)
        VALUES ($1, 'admin@barnes-demo.com', $2, 'admin', 'Barnes', 'Admin', 'active')
        ON CONFLICT (tenant_id, email) DO NOTHING
      `, [tenantId, demoPasswordHash]);

      await client.query(`
        INSERT INTO broker_users (tenant_id, email, password_hash, role, first_name, last_name, status)
        VALUES ($1, 'broker@barnes-demo.com', $2, 'broker', 'Demo', 'Broker', 'active')
        ON CONFLICT (tenant_id, email) DO NOTHING
      `, [tenantId, demoPasswordHash]);

      console.log(`[014] Demo tenant seeded: tenant_id=${tenantId}`);
      console.log('[014]   admin@barnes-demo.com / BarnesDemo2024!');
      console.log('[014]   broker@barnes-demo.com / BarnesDemo2024!');
    }

    console.log('[014] multi_tenant_saas migration complete');
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS broker_invites CASCADE`);
    await client.query(`DROP TABLE IF EXISTS broker_users CASCADE`);
    await client.query(`DROP TABLE IF EXISTS tenants CASCADE`);
    console.log('[014] Rolled back multi_tenant_saas');
  }
};
