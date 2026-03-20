const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const OpenAI = require('openai');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ─── AI CLIENT ───────────────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL
});

// ─── AUTH SETUP ──────────────────────────────────────────────────────────────

// Trust first proxy (Render load balancer) — required for secure cookies
app.set('trust proxy', 1);

// Session middleware
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Barnesos2024!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'barnesos-internal-session-secret-2024';

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// requireAuth middleware — redirects pages, returns 401 for API
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  // Redirect to broker login (email+password) — legacy /login is for internal Barnes team only
  return res.redirect('/broker/login');
}

// Block unauthenticated access to HTML pages and root
// (Runs before express.static to intercept static file serving)
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/login.html') return next();
  if (req.path.startsWith('/api/') || req.path === '/health') return next();
  // Allow broker portal pages through (they handle their own auth)
  if (req.path.startsWith('/broker')) return next();
  // Block root (express.static would serve public/index.html) and .html files
  if (req.path === '/' || req.path.endsWith('.html')) {
    if (!req.session || !req.session.authenticated) {
      // Redirect to broker login (email+password) — legacy /login is for internal Barnes team only
      return res.redirect('/broker/login');
    }
  }
  next();
});

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────

// Serve login page
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login endpoint
app.post('/api/auth/login', express.json(), (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ success: false, message: 'Password is required' });
  }
  if (password === SITE_PASSWORD) {
    req.session.authenticated = true;
    req.session.authenticatedAt = new Date().toISOString();
    return res.json({ success: true, redirect: '/' });
  }
  return res.status(401).json({ success: false, message: 'Incorrect access code. Try again.' });
});

// Logout endpoint
app.get('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// ─── BROKER AUTH UTILITIES ───────────────────────────────────────────────────

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, buf) => {
      if (err) reject(err);
      else resolve(buf.toString('hex'));
    });
  });
  return `${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, buf) => {
      if (err) reject(err);
      else resolve(buf.toString('hex'));
    });
  });
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

function generateToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ─── BILLING CONFIG ───────────────────────────────────────────────────────────
const STRIPE_SUBSCRIPTION_URL = 'https://buy.stripe.com/14A28r0fsgWI0NO4GSdkK1N';
const BILLING_SECRET = process.env.BILLING_SECRET || SESSION_SECRET + '-billing';
const TRIAL_DAYS = 14;

// Sign a billing activation token (HMAC-SHA256)
function signBillingToken(tenantId) {
  const ts = Date.now();
  const msg = `${tenantId}:${ts}`;
  const sig = crypto.createHmac('sha256', BILLING_SECRET).update(msg).digest('hex');
  return { token: `${tenantId}:${ts}:${sig}`, tenantId, ts };
}

function verifyBillingToken(token) {
  try {
    const [tid, ts, sig] = token.split(':');
    if (!tid || !ts || !sig) return null;
    // Token expires after 1 hour
    if (Date.now() - parseInt(ts) > 3600000) return null;
    const expected = crypto.createHmac('sha256', BILLING_SECRET).update(`${tid}:${ts}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    return parseInt(tid);
  } catch (_) { return null; }
}

// Compute effective billing status for a tenant row
function effectiveBillingStatus(tenant) {
  if (!tenant) return 'unknown';
  const status = tenant.billing_status || 'trial';
  if (status === 'trial') {
    const trialEnd = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
    if (trialEnd && new Date() > trialEnd) return 'past_due';
  }
  return status;
}

function trialDaysRemaining(tenant) {
  if (!tenant || !tenant.trial_ends_at) return 0;
  const diff = new Date(tenant.trial_ends_at) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// requireBrokerAuth — verifies broker session (tenant-scoped)
function requireBrokerAuth(req, res, next) {
  if (req.session && req.session.brokerUser) return next();
  return res.status(401).json({ success: false, message: 'Broker authentication required' });
}

// requireBrokerAdmin — broker must have admin role
function requireBrokerAdmin(req, res, next) {
  if (req.session && req.session.brokerUser && req.session.brokerUser.role === 'admin') return next();
  return res.status(403).json({ success: false, message: 'Admin access required' });
}

// ─── BROKER AUTH ROUTES ───────────────────────────────────────────────────────
// All at /api/broker/* — exempt from the internal SITE_PASSWORD guard below

// POST /api/broker/signup — create new tenant + admin user
app.post('/api/broker/signup', express.json(), async (req, res) => {
  const { tenant_name, slug, email, password, first_name, last_name } = req.body;
  if (!tenant_name || !slug || !email || !password) {
    return res.status(400).json({ success: false, message: 'tenant_name, slug, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  }
  const slugClean = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  try {
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: existing } = await client.query(
        `SELECT id FROM tenants WHERE slug = $1`, [slugClean]
      );
      if (existing.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'That subdomain is already taken' });
      }

      const { rows: tenantRows } = await client.query(
        `INSERT INTO tenants (name, slug, billing_status, trial_ends_at)
         VALUES ($1, $2, 'trial', NOW() + INTERVAL '${TRIAL_DAYS} days')
         RETURNING id, name, slug, primary_color, logo_url, company_display_name, billing_status, trial_ends_at`,
        [tenant_name, slugClean]
      );
      const tenant = tenantRows[0];

      const { rows: userRows } = await client.query(
        `INSERT INTO broker_users (tenant_id, email, password_hash, role, first_name, last_name, status)
         VALUES ($1, $2, $3, 'admin', $4, $5, 'active')
         RETURNING id, tenant_id, email, role, first_name, last_name`,
        [tenant.id, email.toLowerCase(), passwordHash, first_name || '', last_name || '']
      );
      const user = userRows[0];

      await client.query('COMMIT');

      req.session.brokerUser = { id: user.id, tenant_id: tenant.id, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name };
      req.session.brokerTenant = { id: tenant.id, name: tenant.name, slug: tenant.slug, primary_color: tenant.primary_color, logo_url: tenant.logo_url, company_display_name: tenant.company_display_name, billing_status: tenant.billing_status, trial_ends_at: tenant.trial_ends_at };

      return res.json({ success: true, user: req.session.brokerUser, tenant: req.session.brokerTenant, redirect: '/broker/dashboard' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[Broker] Signup error:', err.message);
    return res.status(500).json({ success: false, message: 'Signup failed' });
  }
});

// POST /api/broker/login — email/password login (tenant-scoped by email)
app.post('/api/broker/login', express.json(), async (req, res) => {
  const { email, password, tenant_slug } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }
  try {
    let query, params;
    if (tenant_slug) {
      query = `
        SELECT bu.id, bu.tenant_id, bu.email, bu.password_hash, bu.role,
               bu.first_name, bu.last_name, bu.status,
               t.name as tenant_name, t.slug as tenant_slug, t.primary_color,
               t.logo_url, t.company_display_name,
               t.billing_status, t.trial_ends_at, t.subscription_started_at
        FROM broker_users bu
        JOIN tenants t ON t.id = bu.tenant_id
        WHERE bu.email = $1 AND t.slug = $2 AND t.status = 'active'
        LIMIT 1
      `;
      params = [email.toLowerCase(), tenant_slug];
    } else {
      query = `
        SELECT bu.id, bu.tenant_id, bu.email, bu.password_hash, bu.role,
               bu.first_name, bu.last_name, bu.status,
               t.name as tenant_name, t.slug as tenant_slug, t.primary_color,
               t.logo_url, t.company_display_name,
               t.billing_status, t.trial_ends_at, t.subscription_started_at
        FROM broker_users bu
        JOIN tenants t ON t.id = bu.tenant_id
        WHERE bu.email = $1 AND t.status = 'active'
        ORDER BY bu.created_at ASC
        LIMIT 1
      `;
      params = [email.toLowerCase()];
    }

    const { rows } = await pool.query(query, params);
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
    const user = rows[0];

    if (user.status === 'disabled') {
      return res.status(403).json({ success: false, message: 'Account disabled. Contact your admin.' });
    }
    if (user.status === 'invited') {
      return res.status(403).json({ success: false, message: 'Please accept your invitation first.' });
    }
    if (!user.password_hash) {
      return res.status(401).json({ success: false, message: 'Password not set. Use your invitation link.' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    await pool.query(`UPDATE broker_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    req.session.brokerUser = { id: user.id, tenant_id: user.tenant_id, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name };
    req.session.brokerTenant = { id: user.tenant_id, name: user.tenant_name, slug: user.tenant_slug, primary_color: user.primary_color, logo_url: user.logo_url, company_display_name: user.company_display_name, billing_status: user.billing_status || 'active', trial_ends_at: user.trial_ends_at, subscription_started_at: user.subscription_started_at };

    return res.json({ success: true, user: req.session.brokerUser, tenant: req.session.brokerTenant });
  } catch (err) {
    console.error('[Broker] Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// GET /api/broker/me — current broker session info
app.get('/api/broker/me', requireBrokerAuth, (req, res) => {
  return res.json({ success: true, user: req.session.brokerUser, tenant: req.session.brokerTenant });
});

// GET /api/broker/logout
app.get('/api/broker/logout', (req, res) => {
  delete req.session.brokerUser;
  delete req.session.brokerTenant;
  return res.redirect('/broker/login');
});

// POST /api/broker/invite — admin invites team member
app.post('/api/broker/invite', express.json(), requireBrokerAuth, requireBrokerAdmin, async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
  const inviteRole = role === 'admin' ? 'admin' : 'broker';
  const tenantId = req.session.brokerTenant.id;
  try {
    // Check not already a user in this tenant
    const { rows: existing } = await pool.query(
      `SELECT id, status FROM broker_users WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email.toLowerCase()]
    );
    if (existing.length > 0 && existing[0].status === 'active') {
      return res.status(409).json({ success: false, message: 'User already exists in this team' });
    }

    const token = generateToken(48);

    await pool.query(
      `INSERT INTO broker_invites (tenant_id, email, role, token, invited_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [tenantId, email.toLowerCase(), inviteRole, token, req.session.brokerUser.id]
    );

    // Also create placeholder user with 'invited' status
    await pool.query(
      `INSERT INTO broker_users (tenant_id, email, role, status)
       VALUES ($1, $2, $3, 'invited')
       ON CONFLICT (tenant_id, email) DO UPDATE SET role = $3, status = 'invited'`,
      [tenantId, email.toLowerCase(), inviteRole]
    );

    const inviteUrl = `${req.protocol}://${req.get('host')}/broker/accept-invite?token=${token}`;
    console.log(`[Broker] Invite created for ${email}: ${inviteUrl}`);

    return res.json({ success: true, invite_url: inviteUrl, token, role: inviteRole });
  } catch (err) {
    console.error('[Broker] Invite error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create invite' });
  }
});

// GET /api/broker/invite-info — get invite details (public)
app.get('/api/broker/invite-info', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ success: false, message: 'Token required' });
  try {
    const { rows } = await pool.query(
      `SELECT bi.email, bi.role, bi.expires_at, bi.accepted_at,
              t.name as tenant_name, t.slug as tenant_slug
       FROM broker_invites bi
       JOIN tenants t ON t.id = bi.tenant_id
       WHERE bi.token = $1`,
      [token]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Invalid invite token' });
    const invite = rows[0];
    if (invite.accepted_at) return res.status(410).json({ success: false, message: 'Invite already accepted' });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ success: false, message: 'Invite has expired' });
    return res.json({ success: true, invite: { email: invite.email, role: invite.role, tenant_name: invite.tenant_name, tenant_slug: invite.tenant_slug } });
  } catch (err) {
    console.error('[Broker] Invite-info error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch invite info' });
  }
});

// POST /api/broker/accept-invite — set password and activate account
app.post('/api/broker/accept-invite', express.json(), async (req, res) => {
  const { token, password, first_name, last_name } = req.body;
  if (!token || !password) return res.status(400).json({ success: false, message: 'Token and password are required' });
  if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  try {
    const { rows } = await pool.query(
      `SELECT bi.id, bi.tenant_id, bi.email, bi.role, bi.expires_at, bi.accepted_at
       FROM broker_invites bi
       WHERE bi.token = $1`,
      [token]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Invalid invite token' });
    const invite = rows[0];
    if (invite.accepted_at) return res.status(410).json({ success: false, message: 'Invite already accepted' });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ success: false, message: 'Invite has expired' });

    const passwordHash = await hashPassword(password);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: userRows } = await client.query(
        `UPDATE broker_users
         SET password_hash = $1, status = 'active', first_name = $2, last_name = $3
         WHERE tenant_id = $4 AND email = $5
         RETURNING id, tenant_id, email, role, first_name, last_name`,
        [passwordHash, first_name || '', last_name || '', invite.tenant_id, invite.email]
      );
      await client.query(
        `UPDATE broker_invites SET accepted_at = NOW() WHERE id = $1`,
        [invite.id]
      );
      await client.query('COMMIT');

      const user = userRows[0];
      const { rows: tenantRows } = await pool.query(
        `SELECT id, name, slug, primary_color, logo_url, company_display_name, billing_status, trial_ends_at, subscription_started_at FROM tenants WHERE id = $1`, [invite.tenant_id]
      );
      const tenant = tenantRows[0];

      req.session.brokerUser = { id: user.id, tenant_id: user.tenant_id, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name };
      req.session.brokerTenant = { id: tenant.id, name: tenant.name, slug: tenant.slug, primary_color: tenant.primary_color, logo_url: tenant.logo_url, company_display_name: tenant.company_display_name, billing_status: tenant.billing_status || 'active', trial_ends_at: tenant.trial_ends_at, subscription_started_at: tenant.subscription_started_at };

      return res.json({ success: true, user: req.session.brokerUser, tenant: req.session.brokerTenant });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[Broker] Accept invite error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to accept invite' });
  }
});

// GET /api/broker/team — list team members (admin only)
app.get('/api/broker/team', requireBrokerAuth, requireBrokerAdmin, async (req, res) => {
  const tenantId = req.session.brokerTenant.id;
  try {
    const { rows } = await pool.query(
      `SELECT id, email, role, status, first_name, last_name, last_login_at, created_at
       FROM broker_users
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [tenantId]
    );
    return res.json({ success: true, team: rows });
  } catch (err) {
    console.error('[Broker] Team error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch team' });
  }
});

// PUT /api/broker/team/:id — update member role/status (admin only)
app.put('/api/broker/team/:id', express.json(), requireBrokerAuth, requireBrokerAdmin, async (req, res) => {
  const tenantId = req.session.brokerTenant.id;
  const { id } = req.params;
  const { role, status } = req.body;
  // Can't demote yourself
  if (parseInt(id) === req.session.brokerUser.id) {
    return res.status(400).json({ success: false, message: 'Cannot modify your own account' });
  }
  try {
    const updates = [];
    const params = [tenantId, id];
    if (role) { params.push(role); updates.push(`role = $${params.length}`); }
    if (status) { params.push(status); updates.push(`status = $${params.length}`); }
    if (!updates.length) return res.status(400).json({ success: false, message: 'No fields to update' });

    const { rows } = await pool.query(
      `UPDATE broker_users SET ${updates.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING id, email, role, status`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error('[Broker] Team update error:', err.message);
    return res.status(500).json({ success: false, message: 'Update failed' });
  }
});

// ─── BILLING API ─────────────────────────────────────────────────────────────

// GET /api/broker/billing/status — returns current billing status for tenant
app.get('/api/broker/billing/status', requireBrokerAuth, async (req, res) => {
  const tenantId = req.session.brokerTenant.id;
  try {
    const { rows } = await pool.query(
      `SELECT billing_status, trial_ends_at, subscription_started_at FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const t = rows[0];
    const status = effectiveBillingStatus(t);

    // Auto-update if trial expired
    if (status === 'past_due' && t.billing_status === 'trial') {
      await pool.query(`UPDATE tenants SET billing_status = 'past_due' WHERE id = $1`, [tenantId]);
      req.session.brokerTenant.billing_status = 'past_due';
    }

    return res.json({
      success: true,
      billing: {
        status,
        trial_ends_at: t.trial_ends_at,
        trial_days_remaining: trialDaysRemaining(t),
        subscription_started_at: t.subscription_started_at,
        stripe_url: STRIPE_SUBSCRIPTION_URL
      }
    });
  } catch (err) {
    console.error('[Billing] Status error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch billing status' });
  }
});

// POST /api/broker/billing/activate — called after successful Stripe payment
// Uses signed token to identify tenant (passed through success_url)
app.post('/api/broker/billing/activate', requireBrokerAuth, async (req, res) => {
  const tenantId = req.session.brokerTenant.id;
  try {
    const { rows } = await pool.query(
      `UPDATE tenants
       SET billing_status = 'active',
           subscription_started_at = COALESCE(subscription_started_at, NOW())
       WHERE id = $1
       RETURNING billing_status, subscription_started_at`,
      [tenantId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Tenant not found' });

    // Refresh session
    req.session.brokerTenant.billing_status = 'active';
    req.session.brokerTenant.subscription_started_at = rows[0].subscription_started_at;

    return res.json({ success: true, billing_status: 'active' });
  } catch (err) {
    console.error('[Billing] Activate error:', err.message);
    return res.status(500).json({ success: false, message: 'Activation failed' });
  }
});

// ─── BRANDING API ────────────────────────────────────────────────────────────

// GET /api/broker/branding — get current tenant branding settings
app.get('/api/broker/branding', requireBrokerAuth, async (req, res) => {
  const tenantId = req.session.brokerTenant.id;
  try {
    const { rows } = await pool.query(
      `SELECT primary_color, logo_url, company_display_name FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const t = rows[0];
    return res.json({
      success: true,
      branding: {
        primary_color: t.primary_color || '#c9a84c',
        logo_url: t.logo_url || null,
        company_display_name: t.company_display_name || null
      }
    });
  } catch (err) {
    console.error('[Branding] GET error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch branding' });
  }
});

// PUT /api/broker/branding — update primary_color + company_display_name (admin only)
app.put('/api/broker/branding', requireBrokerAuth, express.json(), async (req, res) => {
  if (req.session.brokerUser.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin only' });
  }
  const tenantId = req.session.brokerTenant.id;
  try {
    const { primary_color, company_display_name } = req.body;
    const updates = [];
    const params = [];

    if (primary_color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(primary_color)) {
        return res.status(400).json({ success: false, message: 'Color must be a valid 6-digit hex (e.g. #c9a84c)' });
      }
      params.push(primary_color);
      updates.push(`primary_color = $${params.length}`);
    }
    if (company_display_name !== undefined) {
      params.push((company_display_name || '').trim().slice(0, 255));
      updates.push(`company_display_name = $${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ success: false, message: 'Nothing to update' });

    params.push(tenantId);
    const { rows } = await pool.query(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING primary_color, logo_url, company_display_name`,
      params
    );
    const t = rows[0];
    // Refresh session
    req.session.brokerTenant.primary_color = t.primary_color;
    req.session.brokerTenant.company_display_name = t.company_display_name;

    return res.json({
      success: true,
      branding: { primary_color: t.primary_color, logo_url: t.logo_url, company_display_name: t.company_display_name }
    });
  } catch (err) {
    console.error('[Branding] PUT error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to update branding' });
  }
});

// POST /api/broker/branding/logo — upload logo (base64 JSON body)
app.post('/api/broker/branding/logo', requireBrokerAuth, express.json({ limit: '3mb' }), async (req, res) => {
  if (req.session.brokerUser.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin only' });
  }
  const tenantId = req.session.brokerTenant.id;
  const tenantSlug = req.session.brokerTenant.slug;
  try {
    const { logo_data, mime_type } = req.body;
    if (!logo_data || !mime_type) {
      return res.status(400).json({ success: false, message: 'logo_data and mime_type are required' });
    }
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowed.includes(mime_type)) {
      return res.status(400).json({ success: false, message: 'Unsupported image type. Use PNG, JPG, WebP, GIF or SVG.' });
    }

    // Strip data URL prefix if present
    const base64Data = logo_data.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Size check: max 500KB raw
    if (buffer.length > 512000) {
      return res.status(400).json({ success: false, message: 'Logo too large. Max 500KB.' });
    }

    let logoUrl;
    const R2_BASE = process.env.POLSIA_R2_BASE_URL;

    if (R2_BASE) {
      // Upload to Polsia R2 proxy
      try {
        const ext = mime_type === 'image/svg+xml' ? 'svg' : mime_type.split('/')[1];
        const filename = `logos/${tenantSlug}-${tenantId}.${ext}`;
        const uploadRes = await fetch(`${R2_BASE}/${filename}`, {
          method: 'PUT',
          headers: { 'Content-Type': mime_type },
          body: buffer
        });
        if (uploadRes.ok) {
          logoUrl = `${R2_BASE}/${filename}?v=${Date.now()}`;
        } else {
          throw new Error(`R2 returned ${uploadRes.status}`);
        }
      } catch (uploadErr) {
        console.error('[Branding] R2 upload error, falling back to data URL:', uploadErr.message);
        logoUrl = `data:${mime_type};base64,${base64Data}`;
      }
    } else {
      // Store as data URL (works fine for MVP without R2)
      logoUrl = `data:${mime_type};base64,${base64Data}`;
    }

    const { rows } = await pool.query(
      `UPDATE tenants SET logo_url = $1 WHERE id = $2 RETURNING logo_url`,
      [logoUrl, tenantId]
    );
    req.session.brokerTenant.logo_url = rows[0].logo_url;

    return res.json({ success: true, logo_url: rows[0].logo_url });
  } catch (err) {
    console.error('[Branding] Logo upload error:', err.message);
    return res.status(500).json({ success: false, message: 'Logo upload failed' });
  }
});

// DELETE /api/broker/branding/logo — remove logo
app.delete('/api/broker/branding/logo', requireBrokerAuth, async (req, res) => {
  if (req.session.brokerUser.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin only' });
  }
  const tenantId = req.session.brokerTenant.id;
  try {
    await pool.query(`UPDATE tenants SET logo_url = NULL WHERE id = $1`, [tenantId]);
    req.session.brokerTenant.logo_url = null;
    return res.json({ success: true });
  } catch (err) {
    console.error('[Branding] Logo delete error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to remove logo' });
  }
});

// ─── API AUTH GUARD ───────────────────────────────────────────────────────────
// Protect all /api routes except auth + broker endpoints
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/broker/')) return next();
  if (!req.session || !req.session.authenticated) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BROKER RADAR API — Tenant-scoped Signal Radar endpoints
// All routes require requireBrokerAuth and scope data to req.session.brokerTenant.id
// ═══════════════════════════════════════════════════════════════════════════════

// ─── BROKER RADAR: Stats ─────────────────────────────────────────────────────
app.get('/api/broker/radar/stats', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { rows: tierRows } = await pool.query(
      `SELECT heat_tier, COUNT(*) as count FROM prospects WHERE tenant_id = $1 GROUP BY heat_tier`,
      [tid]
    );
    const tiers = { hot: 0, warm: 0, cold: 0 };
    for (const r of tierRows) tiers[r.heat_tier] = parseInt(r.count);

    const { rows: totalRow } = await pool.query(
      `SELECT COUNT(*) as total FROM prospects WHERE tenant_id = $1`, [tid]
    );

    const { rows: hotSignalsRow } = await pool.query(
      `SELECT COUNT(*) as count FROM prospect_signals ps
       JOIN prospects p ON ps.prospect_id = p.id
       WHERE p.tenant_id = $1 AND ps.detected_at >= NOW() - INTERVAL '7 days' AND p.heat_tier = 'hot'`,
      [tid]
    );

    const { rows: allSignalsRow } = await pool.query(
      `SELECT COUNT(*) as count FROM prospect_signals ps
       JOIN prospects p ON ps.prospect_id = p.id
       WHERE p.tenant_id = $1 AND ps.detected_at >= NOW() - INTERVAL '7 days'`,
      [tid]
    );

    const { rows: scanRow } = await pool.query(
      `SELECT sh.started_at, sh.completed_at, sh.status, sh.error_message
       FROM scan_history sh
       WHERE sh.tenant_id = $1
       ORDER BY sh.started_at DESC LIMIT 1`,
      [tid]
    );

    res.json({
      success: true,
      total_prospects: parseInt(totalRow[0].total),
      hot_prospects: tiers.hot,
      warm_prospects: tiers.warm,
      cold_prospects: tiers.cold,
      hot_signals_7d: parseInt(hotSignalsRow[0].count),
      all_signals_7d: parseInt(allSignalsRow[0].count),
      last_scan: scanRow[0] || null
    });
  } catch (err) {
    console.error('[Radar] Stats error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch radar stats' });
  }
});

// ─── BROKER RADAR: List prospects ────────────────────────────────────────────
app.get('/api/broker/radar/prospects', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { tier, search, sort } = req.query;
    let query = `SELECT p.*,
      (SELECT COUNT(*) FROM prospect_signals ps WHERE ps.prospect_id = p.id) as signal_count,
      (SELECT MAX(ps.detected_at) FROM prospect_signals ps WHERE ps.prospect_id = p.id) as latest_signal_date,
      (SELECT ps.title FROM prospect_signals ps WHERE ps.prospect_id = p.id ORDER BY ps.score DESC, ps.detected_at DESC LIMIT 1) as latest_signal_title,
      (SELECT COALESCE(json_agg(sq ORDER BY sq.score DESC, sq.detected_at DESC), '[]'::json) FROM (
        SELECT ps.id, ps.signal_type, ps.title, ps.summary, ps.source_url, ps.source_name, ps.score, ps.detected_at,
               tr.category as trigger_category
        FROM prospect_signals ps
        LEFT JOIN trigger_rules tr ON ps.trigger_rule_id = tr.id
        WHERE ps.prospect_id = p.id
        ORDER BY ps.score DESC, ps.detected_at DESC
        LIMIT 3
      ) sq) as top_signals
      FROM prospects p WHERE p.tenant_id = $1`;
    const params = [tid];

    if (tier && ['hot', 'warm', 'cold'].includes(tier)) {
      params.push(tier);
      query += ` AND p.heat_tier = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.name ILIKE $${params.length} OR p.company ILIKE $${params.length} OR p.location ILIKE $${params.length})`;
    }

    if (sort === 'name') query += ' ORDER BY p.name ASC';
    else if (sort === 'recent') query += ' ORDER BY p.updated_at DESC';
    else query += ' ORDER BY p.heat_score DESC, p.name ASC';

    const { rows } = await pool.query(query, params);
    // Return demo_count so the frontend can show/hide the "Clear Demo Data" banner
    const { rows: demoRows } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM prospects WHERE tenant_id = $1 AND is_demo = TRUE', [tid]
    );
    const demo_count = parseInt(demoRows[0].cnt, 10);
    res.json({ success: true, prospects: rows, count: rows.length, demo_count });
  } catch (err) {
    console.error('[Radar] Prospects error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch prospects' });
  }
});

// ─── BROKER RADAR: Get single prospect ───────────────────────────────────────
app.get('/api/broker/radar/prospects/:id', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { rows: prospects } = await pool.query(
      'SELECT * FROM prospects WHERE id = $1 AND tenant_id = $2', [req.params.id, tid]
    );
    if (prospects.length === 0) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const { rows: signals } = await pool.query(
      `SELECT ps.*, tr.name as trigger_name, tr.category as trigger_category
       FROM prospect_signals ps
       LEFT JOIN trigger_rules tr ON ps.trigger_rule_id = tr.id
       WHERE ps.prospect_id = $1
       ORDER BY ps.detected_at DESC`,
      [req.params.id]
    );
    const { rows: scans } = await pool.query(
      `SELECT * FROM scan_history WHERE prospect_id = $1 AND tenant_id = $2 ORDER BY started_at DESC LIMIT 10`,
      [req.params.id, tid]
    );
    res.json({ success: true, prospect: prospects[0], signals, scan_history: scans });
  } catch (err) {
    console.error('[Radar] Prospect detail error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch prospect' });
  }
});

// ─── BROKER RADAR: Create prospect ───────────────────────────────────────────
app.post('/api/broker/radar/prospects', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { name, email, phone, company, location, current_yacht_interest,
            yacht_brand, yacht_model, social_handles, notes, commercial_contact } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name is required' });

    const { rows } = await pool.query(
      `INSERT INTO prospects (tenant_id, name, email, phone, company, location, current_yacht_interest,
        yacht_brand, yacht_model, social_handles, notes, commercial_contact)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tid, name, email||null, phone||null, company||null, location||null,
       current_yacht_interest||null, yacht_brand||null, yacht_model||null,
       social_handles ? JSON.stringify(social_handles) : '{}', notes||null, commercial_contact||null]
    );
    res.json({ success: true, prospect: rows[0] });
  } catch (err) {
    console.error('[Radar] Create prospect error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create prospect' });
  }
});

// ─── BROKER RADAR: Update prospect ───────────────────────────────────────────
app.put('/api/broker/radar/prospects/:id', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const fields = req.body;
    const id = req.params.id;
    const allowed = ['name','email','phone','company','location','current_yacht_interest',
      'yacht_brand','yacht_model','notes','commercial_contact','heat_tier','heat_score'];
    const setClauses = [];
    const params = [];
    let idx = 1;

    for (const f of allowed) {
      if (fields[f] !== undefined) {
        setClauses.push(`${f} = $${idx}`); params.push(fields[f]); idx++;
      }
    }
    if (fields.social_handles !== undefined) {
      setClauses.push(`social_handles = $${idx}`);
      params.push(JSON.stringify(fields.social_handles)); idx++;
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }
    setClauses.push(`updated_at = NOW()`);
    params.push(id); params.push(tid);

    const { rows } = await pool.query(
      `UPDATE prospects SET ${setClauses.join(', ')} WHERE id = $${idx} AND tenant_id = $${idx + 1} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Prospect not found' });
    res.json({ success: true, prospect: rows[0] });
  } catch (err) {
    console.error('[Radar] Update prospect error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update prospect' });
  }
});

// ─── BROKER RADAR: Clear demo prospects ──────────────────────────────────────
app.delete('/api/broker/radar/prospects/clear-demo', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    // Count first so we can report back
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM prospects WHERE tenant_id = $1 AND is_demo = TRUE', [tid]
    );
    const demoCount = parseInt(countRows[0].cnt, 10);

    if (demoCount === 0) {
      return res.json({ success: true, deleted: 0, message: 'No demo prospects to remove' });
    }

    // Cascade: remove signals and scan history first (FK constraints)
    await pool.query(
      `DELETE FROM prospect_signals WHERE prospect_id IN
        (SELECT id FROM prospects WHERE tenant_id = $1 AND is_demo = TRUE)`, [tid]
    );
    await pool.query(
      `DELETE FROM scan_history WHERE prospect_id IN
        (SELECT id FROM prospects WHERE tenant_id = $1 AND is_demo = TRUE)`, [tid]
    );
    const { rowCount } = await pool.query(
      'DELETE FROM prospects WHERE tenant_id = $1 AND is_demo = TRUE', [tid]
    );

    console.log(`[Radar] Cleared ${rowCount} demo prospects for tenant ${tid}`);
    res.json({ success: true, deleted: rowCount, message: `Removed ${rowCount} demo prospect${rowCount !== 1 ? 's' : ''}` });
  } catch (err) {
    console.error('[Radar] Clear demo error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to clear demo prospects' });
  }
});

// ─── BROKER RADAR: Delete prospect ───────────────────────────────────────────
app.delete('/api/broker/radar/prospects/:id', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM prospects WHERE id = $1 AND tenant_id = $2', [req.params.id, tid]
    );
    if (rowCount === 0) return res.status(404).json({ success: false, message: 'Prospect not found' });
    res.json({ success: true, message: 'Prospect deleted' });
  } catch (err) {
    console.error('[Radar] Delete prospect error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete prospect' });
  }
});

// ─── BROKER RADAR: Bulk import ────────────────────────────────────────────────
app.post('/api/broker/radar/prospects/import', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { prospects } = req.body;
    if (!Array.isArray(prospects) || prospects.length === 0) {
      return res.status(400).json({ success: false, message: 'prospects array is required' });
    }

    const { rows: existing } = await pool.query(
      `SELECT LOWER(name) AS name, LOWER(COALESCE(email,'')) AS email FROM prospects WHERE tenant_id = $1`,
      [tid]
    );
    const existingNames = new Set(existing.map(r => r.name));
    const existingEmails = new Set(existing.filter(r => r.email).map(r => r.email));

    let imported = 0, skipped = 0;
    const errors = [];

    for (let i = 0; i < prospects.length; i++) {
      const p = prospects[i];
      const rowNum = i + 1;
      if (!p.name || !p.name.trim()) {
        errors.push({ row: rowNum, name: p.name || '(empty)', reason: 'Name is required' });
        continue;
      }
      const nameLower = p.name.trim().toLowerCase();
      const emailLower = p.email ? p.email.trim().toLowerCase() : '';
      if (existingNames.has(nameLower) || (emailLower && existingEmails.has(emailLower))) {
        skipped++; continue;
      }
      try {
        await pool.query(
          `INSERT INTO prospects (tenant_id, name, email, phone, company, location, current_yacht_interest,
            yacht_brand, yacht_model, notes, commercial_contact, heat_tier)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [tid, p.name.trim(), p.email||null, p.phone||null, p.company||null, p.location||null,
           p.yacht_interest||null, p.yacht_brand||null, p.yacht_model||null, p.notes||null,
           p.commercial_contact||null,
           ['hot','warm','cold'].includes((p.tier||'').toLowerCase()) ? p.tier.toLowerCase() : 'cold']
        );
        existingNames.add(nameLower);
        if (emailLower) existingEmails.add(emailLower);
        imported++;
      } catch (insertErr) {
        errors.push({ row: rowNum, name: p.name, reason: insertErr.message });
      }
    }

    res.json({ success: true, imported, skipped, errors });
  } catch (err) {
    console.error('[Radar] Import error:', err.message);
    res.status(500).json({ success: false, message: 'Import failed: ' + err.message });
  }
});

// ─── BROKER RADAR: Signal feed ────────────────────────────────────────────────
app.get('/api/broker/radar/signals/feed', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { limit, days } = req.query;
    const maxResults = Math.min(parseInt(limit) || 100, 500);
    const dayRange = parseInt(days) || 30;

    const { rows } = await pool.query(
      `SELECT ps.*, p.name as prospect_name, p.company as prospect_company,
              p.heat_tier, p.location as prospect_location,
              tr.name as trigger_name, tr.category as trigger_category
       FROM prospect_signals ps
       JOIN prospects p ON ps.prospect_id = p.id
       LEFT JOIN trigger_rules tr ON ps.trigger_rule_id = tr.id
       WHERE p.tenant_id = $1 AND ps.detected_at >= NOW() - ($2 || ' days')::INTERVAL
       ORDER BY ps.score DESC, ps.detected_at DESC
       LIMIT $3`,
      [tid, dayRange.toString(), maxResults]
    );

    res.json({ success: true, signals: rows, count: rows.length });
  } catch (err) {
    console.error('[Radar] Signal feed error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch signal feed' });
  }
});

// ─── BROKER RADAR: Scanner status ────────────────────────────────────────────
app.get('/api/broker/radar/scanner/status', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const [recentScansResult, countRow, scannedRow, errRow, tenantRow] = await Promise.all([
      pool.query(
        `SELECT sh.*, p.name as prospect_name
         FROM scan_history sh
         JOIN prospects p ON sh.prospect_id = p.id
         WHERE sh.tenant_id = $1
         ORDER BY sh.started_at DESC LIMIT 5`,
        [tid]
      ),
      pool.query(`SELECT COUNT(*) as total FROM prospects WHERE tenant_id = $1`, [tid]),
      pool.query(`SELECT COUNT(*) as scanned FROM prospects WHERE tenant_id = $1 AND last_scanned_at IS NOT NULL`, [tid]),
      pool.query(
        `SELECT COUNT(*) as errors FROM scan_history sh
         JOIN prospects p ON sh.prospect_id = p.id
         WHERE sh.tenant_id = $1 AND sh.status = 'error' AND sh.started_at >= NOW() - INTERVAL '24 hours'`,
        [tid]
      ),
      pool.query(`SELECT scan_enabled, scan_frequency, last_daily_scan_at FROM tenants WHERE id = $1`, [tid])
    ]);

    const tenant = tenantRow.rows[0] || {};
    // Calculate next scheduled scan time
    let next_scheduled_scan = null;
    if (tenant.scan_enabled && tenant.last_daily_scan_at) {
      const freqHours = tenant.scan_frequency === 'weekly' ? 168 : 24;
      next_scheduled_scan = new Date(new Date(tenant.last_daily_scan_at).getTime() + freqHours * 60 * 60 * 1000).toISOString();
    } else if (tenant.scan_enabled && !tenant.last_daily_scan_at) {
      next_scheduled_scan = 'Scheduled — pending first run';
    }

    res.json({
      success: true,
      recent_scans: recentScansResult.rows,
      total_prospects: parseInt(countRow.rows[0].total),
      scanned_prospects: parseInt(scannedRow.rows[0].scanned),
      errors_24h: parseInt(errRow.rows[0].errors),
      sources_active: ['Google News', 'Web Search'],
      scan_config: {
        scan_enabled: tenant.scan_enabled !== false,
        scan_frequency: tenant.scan_frequency || 'daily',
        last_daily_scan_at: tenant.last_daily_scan_at || null,
        next_scheduled_scan
      }
    });
  } catch (err) {
    console.error('[Radar] Scanner status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch scanner status' });
  }
});

// ─── BROKER RADAR: Get scan configuration ────────────────────────────────────
app.get('/api/broker/radar/scan/config', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { rows } = await pool.query(
      `SELECT scan_enabled, scan_frequency, last_daily_scan_at FROM tenants WHERE id = $1`, [tid]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const t = rows[0];

    const freqHours = t.scan_frequency === 'weekly' ? 168 : 24;
    const next_scheduled_scan = t.scan_enabled && t.last_daily_scan_at
      ? new Date(new Date(t.last_daily_scan_at).getTime() + freqHours * 3600000).toISOString()
      : t.scan_enabled ? 'Pending first run' : null;

    res.json({
      success: true,
      scan_enabled: t.scan_enabled !== false,
      scan_frequency: t.scan_frequency || 'daily',
      last_daily_scan_at: t.last_daily_scan_at || null,
      next_scheduled_scan
    });
  } catch (err) {
    console.error('[Radar] Scan config GET error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get scan config' });
  }
});

// ─── BROKER RADAR: Update scan configuration ─────────────────────────────────
app.post('/api/broker/radar/scan/config', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { scan_enabled, scan_frequency } = req.body;

    const validFreqs = ['daily', 'weekly'];
    const freq = validFreqs.includes(scan_frequency) ? scan_frequency : 'daily';
    const enabled = scan_enabled !== false && scan_enabled !== 'false';

    await pool.query(
      `UPDATE tenants SET scan_enabled = $1, scan_frequency = $2 WHERE id = $3`,
      [enabled, freq, tid]
    );

    console.log(`[Radar] Tenant ${tid} scan config updated: enabled=${enabled}, freq=${freq}`);
    res.json({ success: true, scan_enabled: enabled, scan_frequency: freq });
  } catch (err) {
    console.error('[Radar] Scan config POST error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update scan config' });
  }
});

// ─── BROKER RADAR: Manually trigger full daily scan for tenant ────────────────
app.post('/api/broker/radar/scan/trigger-daily', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { rows: prospects } = await pool.query(
      `SELECT * FROM prospects WHERE tenant_id = $1 ORDER BY
         CASE heat_tier WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 ELSE 3 END,
         last_scanned_at ASC NULLS FIRST
       LIMIT 50`,
      [tid]
    );

    if (!prospects.length) {
      return res.json({ success: true, message: 'No prospects to scan', scanned: 0 });
    }

    // Respond immediately — scan runs in background
    res.json({
      success: true,
      message: `Daily scan triggered for ${prospects.length} prospects`,
      prospect_count: prospects.length
    });

    // Background: scan each prospect with stagger
    (async () => {
      let totalSignals = 0;
      for (const prospect of prospects) {
        try {
          const result = await scanProspect(prospect, 'scheduled');
          totalSignals += result.signals_found;
          await new Promise(r => setTimeout(r, 2000)); // 2s between prospects
        } catch (e) {
          console.error(`[DailyScan] Error scanning ${prospect.name}:`, e.message);
        }
      }
      // Update last_daily_scan_at
      await pool.query(`UPDATE tenants SET last_daily_scan_at = NOW() WHERE id = $1`, [tid]);
      console.log(`[DailyScan] Tenant ${tid} manual trigger complete. ${totalSignals} total signals found.`);
    })();

  } catch (err) {
    console.error('[Radar] Trigger daily scan error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to trigger daily scan' });
  }
});

// ─── BROKER RADAR: Trigger scan for a prospect (tenant-scoped) ───────────────
app.post('/api/broker/radar/scanner/scan/:id', requireBrokerAuth, async (req, res) => {
  const tid = req.session.brokerTenant.id;
  try {
    const { rows: prospects } = await pool.query(
      'SELECT * FROM prospects WHERE id = $1 AND tenant_id = $2', [req.params.id, tid]
    );
    if (prospects.length === 0) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const result = await scanProspect(prospects[0]);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Radar] Scan error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to scan prospect' });
  }
});

// ─── API: Get all yachts (with optional filters) ─────────────────────────────
app.get('/api/yachts', async (req, res) => {
  try {
    const { active, approved, builder, currency, broker,
            min_price, max_price, min_length, max_length,
            min_year_built, max_year_built, search } = req.query;

    const conditions = [];
    const params = [];

    if (req.query.all !== 'true') {
      conditions.push('is_active = TRUE');
    }
    if (active === 'true')    conditions.push('is_active = TRUE');
    if (active === 'false')   conditions.push('is_active = FALSE');
    if (approved === 'true')  conditions.push('is_approved = TRUE');
    if (approved === 'false') conditions.push('is_approved = FALSE');
    if (builder) {
      params.push(`%${builder}%`);
      conditions.push(`builder ILIKE $${params.length}`);
    }
    if (currency) {
      params.push(currency.toUpperCase());
      conditions.push(`currency = $${params.length}`);
    }
    if (broker) {
      params.push(`%${broker}%`);
      conditions.push(`brokers ILIKE $${params.length}`);
    }
    if (min_price)     { params.push(min_price);     conditions.push(`price >= $${params.length}`); }
    if (max_price)     { params.push(max_price);     conditions.push(`price <= $${params.length}`); }
    if (min_length)    { params.push(min_length);    conditions.push(`length >= $${params.length}`); }
    if (max_length)    { params.push(max_length);    conditions.push(`length <= $${params.length}`); }
    if (min_year_built){ params.push(min_year_built);conditions.push(`year_built >= $${params.length}`); }
    if (max_year_built){ params.push(max_year_built);conditions.push(`year_built <= $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(`(name ILIKE $${idx} OR builder ILIKE $${idx} OR location_text ILIKE $${idx} OR brokers ILIKE $${idx})`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM yachts ${where} ORDER BY length DESC NULLS LAST, name ASC`, params
    );
    res.json({ success: true, yachts: rows, count: rows.length });
  } catch (err) {
    console.error('Error fetching yachts:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch yachts' });
  }
});

// ─── API: Get unique filter values ───────────────────────────────────────────
app.get('/api/yachts/filters', async (req, res) => {
  try {
    const [builders, currencies, locations, rangeStats, brokerRows] = await Promise.all([
      pool.query(`SELECT DISTINCT builder FROM yachts WHERE builder IS NOT NULL AND is_active = TRUE ORDER BY builder`),
      pool.query(`SELECT DISTINCT currency FROM yachts WHERE currency IS NOT NULL AND is_active = TRUE ORDER BY currency`),
      pool.query(`SELECT DISTINCT location_text FROM yachts WHERE location_text IS NOT NULL AND is_active = TRUE ORDER BY location_text`),
      pool.query(`SELECT
          MIN(price)      as min_price,  MAX(price)      as max_price,
          MIN(length)     as min_length, MAX(length)     as max_length,
          MIN(lob)        as min_lob,    MAX(lob)        as max_lob,
          MIN(year_built) as min_year_built, MAX(year_built) as max_year_built,
          MIN(year_refit) as min_year_refit, MAX(year_refit) as max_year_refit,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE is_active = TRUE)   as active,
          COUNT(*) FILTER (WHERE is_approved = TRUE) as approved
        FROM yachts`),
      pool.query(`SELECT DISTINCT TRIM(unnest(string_to_array(brokers, ','))) as broker
        FROM yachts WHERE brokers IS NOT NULL AND brokers != '' ORDER BY broker`)
    ]);

    res.json({
      success: true,
      builders:  builders.rows.map(r => r.builder),
      currencies: currencies.rows.map(r => r.currency),
      locations: locations.rows.map(r => r.location_text),
      brokers:   brokerRows.rows.map(r => r.broker).filter(Boolean),
      stats:     rangeStats.rows[0]
    });
  } catch (err) {
    console.error('Error fetching filters:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch filters' });
  }
});

// ─── API: Match yachts to client preferences ────────────────────────────────
app.post('/api/match', async (req, res) => {
  try {
    const {
      budget_min,
      budget_max,
      length_min,
      length_max,
      builders,
      locations,
      year_built_min,
      year_built_max,
      only_approved,
      sort_by
    } = req.body;

    // Keep backward-compat with old `brands` field
    const builderList = builders || req.body.brands || [];

    // Get all active yachts
    const { rows: allYachts } = await pool.query(
      `SELECT * FROM yachts WHERE is_active = TRUE`
    );

    // Score each yacht
    const scored = allYachts.map(yacht => {
      let score = 0;
      let maxScore = 0;
      const reasons = [];

      // Filter: only_approved strict filter
      if (only_approved && !yacht.is_approved) return null;

      // Hard exclusion: brand filter — if user specified brands, exclude non-matching yachts entirely
      if (builderList && builderList.length > 0) {
        const builderMatch = builderList.some(b =>
          (yacht.builder || '').toLowerCase().includes(b.toLowerCase()) ||
          b.toLowerCase().includes((yacht.builder || '').toLowerCase())
        );
        if (!builderMatch) return null;
      }

      // Hard exclusion: location filter — if user specified locations, exclude non-matching yachts entirely
      if (locations && locations.length > 0) {
        const loc = (yacht.location_text || '').toLowerCase();
        const locationMatch = locations.some(l =>
          loc.includes(l.toLowerCase()) || l.toLowerCase().includes(loc)
        );
        if (!locationMatch) return null;
      }

      // Budget match (40 points)
      maxScore += 40;
      const price = Number(yacht.price);
      const bMin = budget_min ? Number(budget_min) : 0;
      const bMax = budget_max ? Number(budget_max) : Infinity;

      if (price >= bMin && price <= bMax) {
        score += 40;
        reasons.push('Within budget');
      } else if (price < bMin && bMin > 0) {
        const diff = (bMin - price) / bMin;
        if (diff < 0.3) {
          score += Math.round(40 * (1 - diff));
          reasons.push('Slightly below budget range');
        } else {
          return null; // Hard exclusion: >30% below budget min
        }
      } else if (bMax !== Infinity && price > bMax) {
        const diff = (price - bMax) / bMax;
        if (diff < 0.3) {
          score += Math.round(40 * (1 - diff));
          reasons.push('Slightly above budget');
        } else {
          return null; // Hard exclusion: >30% above budget max
        }
      }

      // Length match (25 points)
      maxScore += 25;
      const len = Number(yacht.length);
      const lMin = length_min ? Number(length_min) : 0;
      const lMax = length_max ? Number(length_max) : Infinity;

      if (len >= lMin && len <= lMax) {
        score += 25;
        reasons.push('Ideal size');
      } else if (len > 0) {
        const minDist = lMin ? Math.abs(len - lMin) / lMin : 0;
        const maxDist = lMax !== Infinity ? Math.abs(len - lMax) / lMax : 0;
        const dist = Math.min(minDist || maxDist, maxDist || minDist);
        if (dist < 0.25) {
          score += Math.round(25 * (1 - dist));
          reasons.push('Close to desired size');
        } else if (length_min || length_max) {
          return null; // Hard exclusion: >25% outside length range when length filter was specified
        }
      }

      // Builder preference (20 points)
      maxScore += 20;
      if (builderList && builderList.length > 0) {
        if (builderList.some(b => (yacht.builder || '').toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes((yacht.builder || '').toLowerCase()))) {
          score += 20;
          reasons.push('Preferred brand');
        }
      } else {
        score += 10; // No preference = neutral
      }

      // Location preference (10 points)
      maxScore += 10;
      if (locations && locations.length > 0) {
        const loc = (yacht.location_text || '').toLowerCase();
        if (locations.some(l => loc.includes(l.toLowerCase()) || l.toLowerCase().includes(loc))) {
          score += 10;
          reasons.push('Preferred location');
        }
      } else {
        score += 5; // No preference = neutral
      }

      // Year built match (5 points)
      maxScore += 5;
      if (year_built_min || year_built_max) {
        const yb = yacht.year_built;
        const ybMin = year_built_min ? Number(year_built_min) : 0;
        const ybMax = year_built_max ? Number(year_built_max) : 9999;
        if (yb >= ybMin && yb <= ybMax) {
          score += 5;
          reasons.push(`Built ${yb}`);
        }
      } else {
        score += 3;
      }

      // Approved bonus
      if (yacht.is_approved) {
        score += 2;
        reasons.push('Approved listing');
      }

      const relevance = maxScore > 0 ? Math.min(100, Math.round((score / maxScore) * 100)) : 0;

      return {
        ...yacht,
        relevance_score: relevance,
        match_reasons: reasons
      };
    }).filter(Boolean);

    // Filter: only return yachts with relevance >= 20
    let results = scored.filter(y => y.relevance_score >= 20);

    // Sort
    if (sort_by === 'price_asc') {
      results.sort((a, b) => Number(a.price) - Number(b.price));
    } else if (sort_by === 'price_desc') {
      results.sort((a, b) => Number(b.price) - Number(a.price));
    } else if (sort_by === 'length_desc') {
      results.sort((a, b) => Number(b.length) - Number(a.length));
    } else if (sort_by === 'length_asc') {
      results.sort((a, b) => Number(a.length) - Number(b.length));
    } else {
      // Default: sort by relevance
      results.sort((a, b) => b.relevance_score - a.relevance_score);
    }

    // Save the match request
    await pool.query(
      `INSERT INTO match_requests (budget_min, budget_max, length_min, length_max, preferred_brands, preferred_locations, delivery_before, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        budget_min || null, budget_max || null,
        length_min || null, length_max || null,
        builderList && builderList.length > 0 ? builderList : null,
        locations && locations.length > 0 ? locations : null,
        null,
        `Found ${results.length} matches out of ${allYachts.length} available`
      ]
    );

    res.json({
      success: true,
      matches: results,
      total_available: allYachts.length,
      total_matches: results.length
    });
  } catch (err) {
    console.error('Error matching yachts:', err.message);
    res.status(500).json({ success: false, message: 'Failed to match yachts' });
  }
});

// ─── API: Get single yacht details ──────────────────────────────────────────
app.get('/api/yachts/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM yachts WHERE id = $1`, [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Yacht not found' });
    }
    res.json({ success: true, yacht: rows[0] });
  } catch (err) {
    console.error('Error fetching yacht:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch yacht' });
  }
});

// ─── API: Analytics — match request history ─────────────────────────────────
app.get('/api/analytics/matches', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as total_matches,
              AVG(budget_min) as avg_budget_min,
              AVG(budget_max) as avg_budget_max
       FROM match_requests`
    );
    res.json({ success: true, analytics: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// DEAL FLOW TRACKER — Phase C (Internal Admin)
// ═══════════════════════════════════════════════════════════════════════════════

const DEAL_STATUSES = ['identified', 'evaluating', 'offer_made', 'acquired', 'listed', 'sold', 'lost'];
const STATUS_TIMESTAMPS = {
  identified: 'identified_at',
  evaluating: 'evaluating_at',
  offer_made: 'offer_made_at',
  acquired: 'acquired_at',
  listed: 'listed_at',
  sold: 'sold_at'
};

// ─── DEALS: List all deals (with filters) ────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  try {
    const { status, shipyard, brand, sort } = req.query;
    let query = `SELECT d.*, sc.shipyard_name as shipyard_contact_name
                 FROM deals d
                 LEFT JOIN shipyard_contacts sc ON d.shipyard_id = sc.id
                 WHERE 1=1`;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND d.status = $${params.length}`;
    }
    if (shipyard) {
      params.push(`%${shipyard}%`);
      query += ` AND d.shipyard_name ILIKE $${params.length}`;
    }
    if (brand) {
      params.push(`%${brand}%`);
      query += ` AND d.yacht_brand ILIKE $${params.length}`;
    }

    if (sort === 'value_desc') {
      query += ' ORDER BY d.trade_in_value DESC NULLS LAST';
    } else if (sort === 'value_asc') {
      query += ' ORDER BY d.trade_in_value ASC NULLS LAST';
    } else if (sort === 'newest') {
      query += ' ORDER BY d.created_at DESC';
    } else {
      query += ' ORDER BY d.created_at DESC';
    }

    const { rows } = await pool.query(query, params);
    res.json({ success: true, deals: rows, count: rows.length });
  } catch (err) {
    console.error('Error fetching deals:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch deals' });
  }
});

// ─── DEALS: Get single deal with expenses and sale records ───────────────────
app.get('/api/deals/:id', async (req, res) => {
  try {
    const { rows: deals } = await pool.query(
      `SELECT d.*, sc.shipyard_name as shipyard_contact_name, sc.contact_name, sc.contact_email
       FROM deals d
       LEFT JOIN shipyard_contacts sc ON d.shipyard_id = sc.id
       WHERE d.id = $1`, [req.params.id]
    );
    if (deals.length === 0) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    const { rows: expenses } = await pool.query(
      `SELECT * FROM deal_expenses WHERE deal_id = $1 ORDER BY date DESC`, [req.params.id]
    );
    const { rows: sales } = await pool.query(
      `SELECT * FROM sale_records WHERE deal_id = $1 ORDER BY sale_date DESC`, [req.params.id]
    );

    res.json({
      success: true,
      deal: deals[0],
      expenses,
      sales
    });
  } catch (err) {
    console.error('Error fetching deal:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch deal' });
  }
});

// ─── DEALS: Create new deal ──────────────────────────────────────────────────
app.post('/api/deals', async (req, res) => {
  try {
    const {
      yacht_brand, yacht_model, yacht_year, yacht_length_m, yacht_type,
      trade_in_value, acquisition_price,
      seller_name, seller_email, seller_phone, seller_notes,
      new_boat_brand, new_boat_model, new_boat_price,
      shipyard_id, shipyard_name, notes
    } = req.body;

    if (!yacht_brand) {
      return res.status(400).json({ success: false, message: 'yacht_brand is required' });
    }

    // Calculate acquisition percentage
    const acq_pct = (trade_in_value && acquisition_price)
      ? ((acquisition_price / trade_in_value) * 100).toFixed(2)
      : null;

    const { rows } = await pool.query(
      `INSERT INTO deals (
        yacht_brand, yacht_model, yacht_year, yacht_length_m, yacht_type,
        trade_in_value, acquisition_price, acquisition_pct,
        seller_name, seller_email, seller_phone, seller_notes,
        new_boat_brand, new_boat_model, new_boat_price,
        shipyard_id, shipyard_name, notes, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'identified')
      RETURNING *`,
      [
        yacht_brand, yacht_model || null, yacht_year || null, yacht_length_m || null, yacht_type || 'motor',
        trade_in_value || null, acquisition_price || null, acq_pct,
        seller_name || null, seller_email || null, seller_phone || null, seller_notes || null,
        new_boat_brand || null, new_boat_model || null, new_boat_price || null,
        shipyard_id || null, shipyard_name || null, notes || null
      ]
    );

    // Update shipyard deal count
    if (shipyard_id) {
      await pool.query(
        `UPDATE shipyard_contacts SET total_deals = total_deals + 1, updated_at = NOW() WHERE id = $1`,
        [shipyard_id]
      );
    }

    res.json({ success: true, deal: rows[0] });
  } catch (err) {
    console.error('Error creating deal:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create deal' });
  }
});

// ─── DEALS: Update deal ─────────────────────────────────────────────────────
app.put('/api/deals/:id', async (req, res) => {
  try {
    const fields = req.body;
    const id = req.params.id;

    // Build dynamic update
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    const allowedFields = [
      'yacht_brand', 'yacht_model', 'yacht_year', 'yacht_length_m', 'yacht_type',
      'trade_in_value', 'acquisition_price',
      'seller_name', 'seller_email', 'seller_phone', 'seller_notes',
      'new_boat_brand', 'new_boat_model', 'new_boat_price',
      'shipyard_id', 'shipyard_name',
      'listing_price', 'final_sale_price', 'buyer_name', 'buyer_notes',
      'notes', 'status'
    ];

    for (const field of allowedFields) {
      if (fields[field] !== undefined) {
        setClauses.push(`${field} = $${paramIdx}`);
        params.push(fields[field]);
        paramIdx++;
      }
    }

    // Recalculate acquisition_pct if trade-in or acquisition changed
    if (fields.trade_in_value || fields.acquisition_price) {
      const { rows: current } = await pool.query('SELECT trade_in_value, acquisition_price FROM deals WHERE id = $1', [id]);
      if (current.length > 0) {
        const tv = fields.trade_in_value || current[0].trade_in_value;
        const ap = fields.acquisition_price || current[0].acquisition_price;
        if (tv && ap) {
          setClauses.push(`acquisition_pct = $${paramIdx}`);
          params.push(((ap / tv) * 100).toFixed(2));
          paramIdx++;
        }
      }
    }

    // Set status timestamp if status changed
    if (fields.status && STATUS_TIMESTAMPS[fields.status]) {
      const tsCol = STATUS_TIMESTAMPS[fields.status];
      setClauses.push(`${tsCol} = NOW()`);
    }

    // If status is 'sold', set sold_at
    if (fields.status === 'sold') {
      setClauses.push(`sold_at = NOW()`);
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await pool.query(
      `UPDATE deals SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    // Recalculate P&L if deal is sold or has sale data
    if (fields.status === 'sold' || fields.final_sale_price) {
      await recalcDealPnl(id);
    }

    const { rows: updated } = await pool.query('SELECT * FROM deals WHERE id = $1', [id]);
    res.json({ success: true, deal: updated[0] });
  } catch (err) {
    console.error('Error updating deal:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update deal' });
  }
});

// ─── DEALS: Delete deal ──────────────────────────────────────────────────────
app.delete('/api/deals/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM deals WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }
    res.json({ success: true, message: 'Deal deleted' });
  } catch (err) {
    console.error('Error deleting deal:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete deal' });
  }
});

// ─── DEAL EXPENSES: Add expense ──────────────────────────────────────────────
app.post('/api/deals/:id/expenses', async (req, res) => {
  try {
    const { category, description, amount, date } = req.body;
    if (!category || !amount) {
      return res.status(400).json({ success: false, message: 'category and amount are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO deal_expenses (deal_id, category, description, amount, date)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, category, description || null, amount, date || new Date()]
    );

    // Update total_expenses on deal
    await pool.query(
      `UPDATE deals SET total_expenses = (
        SELECT COALESCE(SUM(amount), 0) FROM deal_expenses WHERE deal_id = $1
      ), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    await recalcDealPnl(req.params.id);

    res.json({ success: true, expense: rows[0] });
  } catch (err) {
    console.error('Error adding expense:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add expense' });
  }
});

// ─── DEAL EXPENSES: Delete expense ───────────────────────────────────────────
app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT deal_id FROM deal_expenses WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    const dealId = rows[0].deal_id;

    await pool.query('DELETE FROM deal_expenses WHERE id = $1', [req.params.id]);

    // Recalculate total_expenses
    await pool.query(
      `UPDATE deals SET total_expenses = (
        SELECT COALESCE(SUM(amount), 0) FROM deal_expenses WHERE deal_id = $1
      ), updated_at = NOW() WHERE id = $1`,
      [dealId]
    );

    await recalcDealPnl(dealId);

    res.json({ success: true, message: 'Expense deleted' });
  } catch (err) {
    console.error('Error deleting expense:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete expense' });
  }
});

// ─── SALE RECORDS: Add sale ──────────────────────────────────────────────────
app.post('/api/deals/:id/sales', async (req, res) => {
  try {
    const { buyer_name, buyer_email, buyer_phone, sale_price, commission_pct, payment_method, notes } = req.body;
    if (!sale_price) {
      return res.status(400).json({ success: false, message: 'sale_price is required' });
    }

    const commission_amount = commission_pct ? Math.round(sale_price * (commission_pct / 100)) : null;

    const { rows } = await pool.query(
      `INSERT INTO sale_records (deal_id, buyer_name, buyer_email, buyer_phone, sale_price, commission_pct, commission_amount, payment_method, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, buyer_name||null, buyer_email||null, buyer_phone||null, sale_price, commission_pct||null, commission_amount, payment_method||null, notes||null]
    );

    // Update deal with sale info and move to sold
    await pool.query(
      `UPDATE deals SET final_sale_price = $1, buyer_name = $2, status = 'sold', sold_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [sale_price, buyer_name || null, req.params.id]
    );

    await recalcDealPnl(req.params.id);

    res.json({ success: true, sale: rows[0] });
  } catch (err) {
    console.error('Error adding sale:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add sale record' });
  }
});

// ─── SHIPYARD CONTACTS: CRUD ─────────────────────────────────────────────────
app.get('/api/shipyards', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sc.*,
              (SELECT COUNT(*) FROM deals d WHERE d.shipyard_id = sc.id) as deal_count,
              (SELECT COUNT(*) FROM deals d WHERE d.shipyard_id = sc.id AND d.status = 'sold') as sold_count,
              (SELECT COALESCE(SUM(d.profit), 0) FROM deals d WHERE d.shipyard_id = sc.id AND d.status = 'sold') as total_profit
       FROM shipyard_contacts sc
       ORDER BY sc.shipyard_name`
    );
    res.json({ success: true, shipyards: rows });
  } catch (err) {
    console.error('Error fetching shipyards:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch shipyards' });
  }
});

app.post('/api/shipyards', async (req, res) => {
  try {
    const { shipyard_name, contact_name, contact_email, contact_phone, notes } = req.body;
    if (!shipyard_name) {
      return res.status(400).json({ success: false, message: 'shipyard_name is required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO shipyard_contacts (shipyard_name, contact_name, contact_email, contact_phone, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [shipyard_name, contact_name||null, contact_email||null, contact_phone||null, notes||null]
    );
    res.json({ success: true, shipyard: rows[0] });
  } catch (err) {
    console.error('Error creating shipyard:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create shipyard contact' });
  }
});

app.put('/api/shipyards/:id', async (req, res) => {
  try {
    const { shipyard_name, contact_name, contact_email, contact_phone, relationship_status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE shipyard_contacts SET
        shipyard_name = COALESCE($1, shipyard_name),
        contact_name = COALESCE($2, contact_name),
        contact_email = COALESCE($3, contact_email),
        contact_phone = COALESCE($4, contact_phone),
        relationship_status = COALESCE($5, relationship_status),
        notes = COALESCE($6, notes),
        updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [shipyard_name, contact_name, contact_email, contact_phone, relationship_status, notes, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shipyard not found' });
    }
    res.json({ success: true, shipyard: rows[0] });
  } catch (err) {
    console.error('Error updating shipyard:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update shipyard' });
  }
});

// ─── FUND ANALYTICS ──────────────────────────────────────────────────────────
app.get('/api/deals/analytics/fund', async (req, res) => {
  try {
    // Pipeline summary
    const { rows: pipeline } = await pool.query(
      `SELECT status, COUNT(*) as count,
              COALESCE(SUM(acquisition_price), 0) as total_value
       FROM deals GROUP BY status ORDER BY
       CASE status
         WHEN 'identified' THEN 1
         WHEN 'evaluating' THEN 2
         WHEN 'offer_made' THEN 3
         WHEN 'acquired' THEN 4
         WHEN 'listed' THEN 5
         WHEN 'sold' THEN 6
         WHEN 'lost' THEN 7
       END`
    );

    // Overall fund metrics
    const { rows: fundMetrics } = await pool.query(`
      SELECT
        COUNT(*) as total_deals,
        COUNT(*) FILTER (WHERE status = 'sold') as deals_sold,
        COUNT(*) FILTER (WHERE status IN ('acquired', 'listed')) as deals_in_portfolio,
        COALESCE(SUM(acquisition_price), 0) as total_capital_deployed,
        COALESCE(SUM(acquisition_price) FILTER (WHERE status IN ('acquired', 'listed', 'sold')), 0) as active_capital,
        COALESCE(SUM(final_sale_price) FILTER (WHERE status = 'sold'), 0) as total_revenue,
        COALESCE(SUM(profit) FILTER (WHERE status = 'sold'), 0) as total_profit,
        COALESCE(SUM(total_expenses), 0) as total_expenses,
        ROUND(AVG(acquisition_pct) FILTER (WHERE acquisition_pct IS NOT NULL), 1) as avg_acquisition_pct,
        ROUND(AVG(roi_pct) FILTER (WHERE status = 'sold' AND roi_pct IS NOT NULL), 1) as avg_roi
      FROM deals
    `);

    // Time-to-sale for sold deals
    const { rows: timeMetrics } = await pool.query(`
      SELECT
        ROUND(AVG(EXTRACT(EPOCH FROM (sold_at - acquired_at)) / 86400)) as avg_days_to_sale,
        MIN(EXTRACT(EPOCH FROM (sold_at - acquired_at)) / 86400) as min_days_to_sale,
        MAX(EXTRACT(EPOCH FROM (sold_at - acquired_at)) / 86400) as max_days_to_sale
      FROM deals
      WHERE status = 'sold' AND sold_at IS NOT NULL AND acquired_at IS NOT NULL
    `);

    // Deals by shipyard
    const { rows: byShipyard } = await pool.query(`
      SELECT shipyard_name, COUNT(*) as deal_count,
             COALESCE(SUM(acquisition_price), 0) as total_acquisition,
             COALESCE(SUM(profit) FILTER (WHERE status = 'sold'), 0) as total_profit
      FROM deals
      WHERE shipyard_name IS NOT NULL
      GROUP BY shipyard_name
      ORDER BY deal_count DESC
    `);

    // Monthly deal flow (last 12 months)
    const { rows: monthly } = await pool.query(`
      SELECT
        TO_CHAR(created_at, 'YYYY-MM') as month,
        COUNT(*) as deals_created,
        COUNT(*) FILTER (WHERE status = 'sold') as deals_sold,
        COALESCE(SUM(acquisition_price), 0) as capital_deployed,
        COALESCE(SUM(profit) FILTER (WHERE status = 'sold'), 0) as profit
      FROM deals
      WHERE created_at > NOW() - INTERVAL '12 months'
      GROUP BY TO_CHAR(created_at, 'YYYY-MM')
      ORDER BY month DESC
    `);

    res.json({
      success: true,
      pipeline,
      fund: fundMetrics[0],
      time_metrics: timeMetrics[0],
      by_shipyard: byShipyard,
      monthly
    });
  } catch (err) {
    console.error('Error fetching fund analytics:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch fund analytics' });
  }
});

// ─── P&L Recalculation Helper ────────────────────────────────────────────────
async function recalcDealPnl(dealId) {
  try {
    const { rows } = await pool.query('SELECT acquisition_price, final_sale_price, total_expenses FROM deals WHERE id = $1', [dealId]);
    if (rows.length === 0) return;

    const deal = rows[0];
    const acqPrice = Number(deal.acquisition_price) || 0;
    const salePrice = Number(deal.final_sale_price) || 0;
    const expenses = Number(deal.total_expenses) || 0;
    const totalCost = acqPrice + expenses;
    const profit = salePrice > 0 ? salePrice - totalCost : null;
    const roi = (profit !== null && totalCost > 0) ? ((profit / totalCost) * 100).toFixed(2) : null;

    await pool.query(
      `UPDATE deals SET total_cost = $1, profit = $2, roi_pct = $3, updated_at = NOW() WHERE id = $4`,
      [totalCost, profit, roi, dealId]
    );
  } catch (err) {
    console.error('Error recalculating P&L:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL RADAR — Command Center Panel 2
// ═══════════════════════════════════════════════════════════════════════════════

// ─── COMMAND CENTER: Dashboard KPIs ──────────────────────────────────────────
app.get('/api/command-center/kpis', async (req, res) => {
  try {
    // Prospect counts by tier
    const { rows: tierCounts } = await pool.query(`
      SELECT heat_tier, COUNT(*) as count FROM prospects GROUP BY heat_tier
    `);
    const tiers = { hot: 0, warm: 0, cold: 0 };
    tierCounts.forEach(r => { tiers[r.heat_tier] = parseInt(r.count); });

    // Total prospects
    const { rows: totalRow } = await pool.query('SELECT COUNT(*) as total FROM prospects');

    // Hot signals from the last 7 days (prospects currently in HOT tier)
    const { rows: hotSignals7d } = await pool.query(`
      SELECT COUNT(*) as count
      FROM prospect_signals ps
      JOIN prospects p ON ps.prospect_id = p.id
      WHERE ps.detected_at >= NOW() - INTERVAL '7 days'
        AND p.heat_tier = 'hot'
    `);

    // Fund progress (from deals)
    const { rows: fundRow } = await pool.query(`
      SELECT
        COALESCE(SUM(acquisition_price) FILTER (WHERE status IN ('acquired','listed','sold')), 0) as deployed,
        COALESCE(SUM(profit) FILTER (WHERE status = 'sold'), 0) as profit,
        COUNT(*) as total_deals
      FROM deals
    `);

    // Active matches from match_requests
    const { rows: matchRow } = await pool.query(`
      SELECT COUNT(*) as count FROM match_requests WHERE created_at > NOW() - INTERVAL '30 days'
    `);

    res.json({
      success: true,
      kpis: {
        total_prospects: parseInt(totalRow[0].total),
        hot_prospects: tiers.hot,
        warm_prospects: tiers.warm,
        cold_prospects: tiers.cold,
        hot_signals_today: parseInt(hotSignals7d[0].count),
        fund_deployed: parseFloat(fundRow[0].deployed) || 0,
        fund_profit: parseFloat(fundRow[0].profit) || 0,
        total_deals: parseInt(fundRow[0].total_deals),
        active_matches: parseInt(matchRow[0].count)
      }
    });
  } catch (err) {
    console.error('Error fetching KPIs:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch KPIs' });
  }
});

// ─── PROSPECTS: List all (with tier filter) ──────────────────────────────────
app.get('/api/prospects', async (req, res) => {
  try {
    const { tier, search, sort } = req.query;
    let query = `SELECT p.*,
      (SELECT COUNT(*) FROM prospect_signals ps WHERE ps.prospect_id = p.id) as signal_count,
      (SELECT MAX(ps.detected_at) FROM prospect_signals ps WHERE ps.prospect_id = p.id) as latest_signal_date,
      (SELECT ps.title FROM prospect_signals ps WHERE ps.prospect_id = p.id ORDER BY ps.score DESC, ps.detected_at DESC LIMIT 1) as latest_signal_title,
      (SELECT COALESCE(json_agg(sq ORDER BY sq.score DESC, sq.detected_at DESC), '[]'::json) FROM (
        SELECT ps.id, ps.signal_type, ps.title, ps.summary, ps.source_url, ps.source_name, ps.score, ps.detected_at,
               tr.category as trigger_category
        FROM prospect_signals ps
        LEFT JOIN trigger_rules tr ON ps.trigger_rule_id = tr.id
        WHERE ps.prospect_id = p.id
        ORDER BY ps.score DESC, ps.detected_at DESC
        LIMIT 3
      ) sq) as top_signals
      FROM prospects p WHERE 1=1`;
    const params = [];

    if (tier && ['hot', 'warm', 'cold'].includes(tier)) {
      params.push(tier);
      query += ` AND p.heat_tier = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.name ILIKE $${params.length} OR p.company ILIKE $${params.length} OR p.location ILIKE $${params.length})`;
    }

    if (sort === 'name') {
      query += ' ORDER BY p.name ASC';
    } else if (sort === 'recent') {
      query += ' ORDER BY p.updated_at DESC';
    } else {
      query += ' ORDER BY p.heat_score DESC, p.name ASC';
    }

    const { rows } = await pool.query(query, params);
    res.json({ success: true, prospects: rows, count: rows.length });
  } catch (err) {
    console.error('Error fetching prospects:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch prospects' });
  }
});

// ─── PROSPECTS: Get single prospect with signal history ──────────────────────
app.get('/api/prospects/:id', async (req, res) => {
  try {
    const { rows: prospects } = await pool.query(
      'SELECT * FROM prospects WHERE id = $1', [req.params.id]
    );
    if (prospects.length === 0) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }

    const { rows: signals } = await pool.query(
      `SELECT ps.*, tr.name as trigger_name, tr.category as trigger_category
       FROM prospect_signals ps
       LEFT JOIN trigger_rules tr ON ps.trigger_rule_id = tr.id
       WHERE ps.prospect_id = $1
       ORDER BY ps.detected_at DESC`,
      [req.params.id]
    );

    const { rows: scans } = await pool.query(
      `SELECT * FROM scan_history WHERE prospect_id = $1 ORDER BY started_at DESC LIMIT 10`,
      [req.params.id]
    );

    res.json({
      success: true,
      prospect: prospects[0],
      signals,
      scan_history: scans
    });
  } catch (err) {
    console.error('Error fetching prospect:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch prospect' });
  }
});

// ─── PROSPECTS: Create new prospect ──────────────────────────────────────────
app.post('/api/prospects', async (req, res) => {
  try {
    const { name, email, phone, company, location, current_yacht_interest,
            yacht_brand, yacht_model, social_handles, notes, commercial_contact } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO prospects (name, email, phone, company, location, current_yacht_interest,
        yacht_brand, yacht_model, social_handles, notes, commercial_contact)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, email||null, phone||null, company||null, location||null,
       current_yacht_interest||null, yacht_brand||null, yacht_model||null,
       social_handles ? JSON.stringify(social_handles) : '{}', notes||null, commercial_contact||null]
    );

    res.json({ success: true, prospect: rows[0] });
  } catch (err) {
    console.error('Error creating prospect:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create prospect' });
  }
});

// ─── PROSPECTS: Bulk import via CSV ──────────────────────────────────────────
app.post('/api/prospects/import', async (req, res) => {
  try {
    const { prospects } = req.body;
    if (!Array.isArray(prospects) || prospects.length === 0) {
      return res.status(400).json({ success: false, message: 'prospects array is required' });
    }

    // Load existing names + emails for duplicate detection
    const { rows: existing } = await pool.query(
      `SELECT LOWER(name) AS name, LOWER(COALESCE(email,'')) AS email FROM prospects`
    );
    const existingNames = new Set(existing.map(r => r.name));
    const existingEmails = new Set(existing.filter(r => r.email).map(r => r.email));

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < prospects.length; i++) {
      const p = prospects[i];
      const rowNum = i + 1;

      if (!p.name || !p.name.trim()) {
        errors.push({ row: rowNum, name: p.name || '(empty)', reason: 'Name is required' });
        continue;
      }

      const nameLower = p.name.trim().toLowerCase();
      const emailLower = p.email ? p.email.trim().toLowerCase() : '';

      // Duplicate: same name OR same non-empty email
      if (existingNames.has(nameLower)) {
        skipped++;
        continue;
      }
      if (emailLower && existingEmails.has(emailLower)) {
        skipped++;
        continue;
      }

      try {
        await pool.query(
          `INSERT INTO prospects (name, email, phone, company, location, current_yacht_interest,
            yacht_brand, yacht_model, notes, commercial_contact, heat_tier)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            p.name.trim(),
            p.email ? p.email.trim() : null,
            p.phone ? p.phone.trim() : null,
            p.company ? p.company.trim() : null,
            p.location ? p.location.trim() : null,
            p.yacht_interest ? p.yacht_interest.trim() : null,
            p.yacht_brand ? p.yacht_brand.trim() : null,
            p.yacht_model ? p.yacht_model.trim() : null,
            p.notes ? p.notes.trim() : null,
            p.commercial_contact ? p.commercial_contact.trim() : null,
            ['hot','warm','cold'].includes((p.tier||'').toLowerCase()) ? p.tier.toLowerCase() : 'cold'
          ]
        );
        existingNames.add(nameLower);
        if (emailLower) existingEmails.add(emailLower);
        imported++;
      } catch (insertErr) {
        errors.push({ row: rowNum, name: p.name, reason: insertErr.message });
      }
    }

    res.json({ success: true, imported, skipped, errors });
  } catch (err) {
    console.error('Error importing prospects:', err.message);
    res.status(500).json({ success: false, message: 'Import failed: ' + err.message });
  }
});

// ─── PROSPECTS: Update prospect ──────────────────────────────────────────────
app.put('/api/prospects/:id', async (req, res) => {
  try {
    const fields = req.body;
    const id = req.params.id;
    const allowed = ['name','email','phone','company','location','current_yacht_interest',
      'yacht_brand','yacht_model','notes','commercial_contact','heat_tier','heat_score'];
    const setClauses = [];
    const params = [];
    let idx = 1;

    for (const f of allowed) {
      if (fields[f] !== undefined) {
        setClauses.push(`${f} = $${idx}`);
        params.push(fields[f]);
        idx++;
      }
    }
    if (fields.social_handles !== undefined) {
      setClauses.push(`social_handles = $${idx}`);
      params.push(JSON.stringify(fields.social_handles));
      idx++;
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await pool.query(
      `UPDATE prospects SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    res.json({ success: true, prospect: rows[0] });
  } catch (err) {
    console.error('Error updating prospect:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update prospect' });
  }
});

// ─── PROSPECTS: Delete prospect ──────────────────────────────────────────────
app.delete('/api/prospects/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM prospects WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    res.json({ success: true, message: 'Prospect deleted' });
  } catch (err) {
    console.error('Error deleting prospect:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete prospect' });
  }
});

// ─── TRIGGER RULES: List all ─────────────────────────────────────────────────
app.get('/api/trigger-rules', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tr.*,
        (SELECT COUNT(*) FROM prospect_signals ps WHERE ps.trigger_rule_id = tr.id) as times_triggered
       FROM trigger_rules tr ORDER BY tr.score_weight DESC, tr.name`
    );
    res.json({ success: true, rules: rows });
  } catch (err) {
    console.error('Error fetching trigger rules:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch trigger rules' });
  }
});

// ─── TRIGGER RULES: Create ───────────────────────────────────────────────────
app.post('/api/trigger-rules', async (req, res) => {
  try {
    const { name, description, category, keywords, score_weight } = req.body;
    if (!name || !category || !keywords) {
      return res.status(400).json({ success: false, message: 'name, category, and keywords are required' });
    }
    if (!['high', 'medium', 'low'].includes(category)) {
      return res.status(400).json({ success: false, message: 'category must be high, medium, or low' });
    }

    const { rows } = await pool.query(
      `INSERT INTO trigger_rules (name, description, category, keywords, score_weight)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, description||null, category, keywords, score_weight || (category === 'high' ? 10 : category === 'medium' ? 6 : 3)]
    );
    res.json({ success: true, rule: rows[0] });
  } catch (err) {
    console.error('Error creating trigger rule:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create trigger rule' });
  }
});

// ─── TRIGGER RULES: Update ───────────────────────────────────────────────────
app.put('/api/trigger-rules/:id', async (req, res) => {
  try {
    const { name, description, category, keywords, score_weight, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE trigger_rules SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        category = COALESCE($3, category),
        keywords = COALESCE($4, keywords),
        score_weight = COALESCE($5, score_weight),
        is_active = COALESCE($6, is_active),
        updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [name, description, category, keywords, score_weight, is_active, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Trigger rule not found' });
    }
    res.json({ success: true, rule: rows[0] });
  } catch (err) {
    console.error('Error updating trigger rule:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update trigger rule' });
  }
});

// ─── TRIGGER RULES: Delete ───────────────────────────────────────────────────
app.delete('/api/trigger-rules/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM trigger_rules WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Trigger rule not found' });
    }
    res.json({ success: true, message: 'Trigger rule deleted' });
  } catch (err) {
    console.error('Error deleting trigger rule:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete trigger rule' });
  }
});

// ─── SIGNALS: Feed (all signals, ranked) ─────────────────────────────────────
app.get('/api/signals/feed', async (req, res) => {
  try {
    const { limit, days } = req.query;
    const maxResults = Math.min(parseInt(limit) || 50, 200);
    const dayRange = parseInt(days) || 30;

    const { rows } = await pool.query(
      `SELECT ps.*, p.name as prospect_name, p.company as prospect_company,
              p.heat_tier, p.location as prospect_location,
              tr.name as trigger_name, tr.category as trigger_category
       FROM prospect_signals ps
       JOIN prospects p ON ps.prospect_id = p.id
       LEFT JOIN trigger_rules tr ON ps.trigger_rule_id = tr.id
       WHERE ps.detected_at >= NOW() - ($1 || ' days')::INTERVAL
       ORDER BY ps.score DESC, ps.detected_at DESC
       LIMIT $2`,
      [dayRange.toString(), maxResults]
    );

    res.json({ success: true, signals: rows, count: rows.length });
  } catch (err) {
    console.error('Error fetching signal feed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch signal feed' });
  }
});

// ─── SIGNALS: Daily digest summary ──────────────────────────────────────────
app.get('/api/signals/digest', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const { rows: signals } = await pool.query(
      `SELECT ps.*, p.name as prospect_name, p.company as prospect_company,
              p.heat_tier, tr.name as trigger_name, tr.category as trigger_category
       FROM prospect_signals ps
       JOIN prospects p ON ps.prospect_id = p.id
       LEFT JOIN trigger_rules tr ON ps.trigger_rule_id = tr.id
       WHERE DATE(ps.detected_at) = $1
       ORDER BY ps.score DESC`,
      [date]
    );

    const { rows: tierSummary } = await pool.query(
      `SELECT p.heat_tier, COUNT(DISTINCT ps.id) as signal_count
       FROM prospect_signals ps
       JOIN prospects p ON ps.prospect_id = p.id
       WHERE DATE(ps.detected_at) = $1
       GROUP BY p.heat_tier`,
      [date]
    );

    res.json({
      success: true,
      date,
      signals,
      summary: {
        total: signals.length,
        by_tier: tierSummary
      }
    });
  } catch (err) {
    console.error('Error fetching digest:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch digest' });
  }
});

// ─── SIGNALS: Manual signal creation (for testing/manual entry) ──────────────
app.post('/api/signals', async (req, res) => {
  try {
    const { prospect_id, trigger_rule_id, signal_type, title, summary, source_url, source_name, score } = req.body;
    if (!prospect_id || !signal_type || !title) {
      return res.status(400).json({ success: false, message: 'prospect_id, signal_type, and title are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO prospect_signals (prospect_id, trigger_rule_id, signal_type, title, summary, source_url, source_name, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [prospect_id, trigger_rule_id||null, signal_type, title, summary||null, source_url||null, source_name||null, score||0]
    );

    // Recalculate prospect heat
    await recalcProspectHeat(prospect_id);

    res.json({ success: true, signal: rows[0] });
  } catch (err) {
    console.error('Error creating signal:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create signal' });
  }
});

// ─── SCANNER: Trigger manual scan for a prospect ────────────────────────────
app.post('/api/scanner/scan/:id', async (req, res) => {
  try {
    const prospectId = req.params.id;
    const { rows: prospects } = await pool.query('SELECT * FROM prospects WHERE id = $1', [prospectId]);
    if (prospects.length === 0) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }

    const result = await scanProspect(prospects[0]);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Error scanning prospect:', err.message);
    res.status(500).json({ success: false, message: 'Failed to scan prospect' });
  }
});

// ─── SCANNER: Trigger scan for all prospects ─────────────────────────────────
app.post('/api/scanner/scan-all', async (req, res) => {
  try {
    // HOT prospects first (most valuable), then WARM, then COLD
    // Within each tier, scan stale ones first (last_scanned_at ASC NULLS FIRST)
    const { rows: prospects } = await pool.query(
      `SELECT * FROM prospects
       ORDER BY
         CASE heat_tier WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 ELSE 3 END ASC,
         last_scanned_at ASC NULLS FIRST
       LIMIT 50`
    );
    const results = { scanned: 0, signals_found: 0, errors: 0, details: [] };

    for (const prospect of prospects) {
      try {
        const result = await scanProspect(prospect);
        results.scanned++;
        results.signals_found += result.signals_found;
        results.details.push({ name: prospect.name, tier: prospect.heat_tier, signals: result.signals_found });
      } catch (err) {
        results.errors++;
        console.error(`Scan error for ${prospect.name}:`, err.message);
        results.details.push({ name: prospect.name, tier: prospect.heat_tier, error: err.message });
      }
      // Small delay between prospects to be courteous to upstream APIs
      if (prospects.indexOf(prospect) < prospects.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    res.json({ success: true, ...results });
  } catch (err) {
    console.error('Error in bulk scan:', err.message);
    res.status(500).json({ success: false, message: 'Failed to run bulk scan' });
  }
});

// ─── Signal Scanner Engine (Enhanced) ────────────────────────────────────────

// Source quality tiers for score multipliers
const SOURCE_TIERS = {
  // Tier 1: Major business/wealth media — 1.5x
  tier1: {
    names: ['bloomberg', 'financial times', 'ft.com', 'forbes', 'reuters', 'wsj', 'wall street journal', 'fortune', 'business insider', 'cnbc', 'the economist'],
    multiplier: 1.5
  },
  // Tier 2: Yacht-specific media — 2x
  tier2: {
    names: ['superyachtnews', 'boatinternational', 'boat international', 'yachtcharterfleet', 'superyachtfan', 'thesuperyachtreport', 'superyacht report', 'yachtingworld', 'yachting world', 'yachtingmagazine', 'yachting magazine', 'theyachtmarket', 'yacht market', 'yachts.co', 'superyachts.com', 'charterworld', 'burgess', 'camper nicholsons', 'edmiston', 'fraser yachts', 'northrop & johnson'],
    multiplier: 2.0
  },
  // Social media — 0.5x
  social: {
    names: ['twitter', 'x.com', 'instagram', 'linkedin', 'facebook', 'tiktok', 'reddit'],
    multiplier: 0.5
  }
};

// Get source quality multiplier based on source name or URL
function getSourceMultiplier(sourceName, url) {
  const text = `${(sourceName || '')} ${(url || '')}`.toLowerCase();
  for (const [tier, config] of Object.entries(SOURCE_TIERS)) {
    if (config.names.some(n => text.includes(n))) return config.multiplier;
  }
  return 1.0;
}

// Fetch Google News RSS for a query (real live results)
function fetchGoogleNewsRSS(query, maxResults = 10) {
  return new Promise((resolve) => {
    const encodedQuery = encodeURIComponent(query);
    const path = `/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;
    const options = {
      hostname: 'news.google.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BarnesOS/1.0; Signal Scanner)',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      timeout: 8000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const items = parseRSSItems(data, maxResults);
          resolve(items);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

// Simple RSS XML parser (no external deps needed)
function parseRSSItems(xml, maxResults = 10) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRe.exec(xml)) !== null && items.length < maxResults) {
    const chunk = match[1];
    const title = extractXmlTag(chunk, 'title');
    const link = extractXmlTag(chunk, 'link') || extractXmlTag(chunk, 'guid');
    const pubDate = extractXmlTag(chunk, 'pubDate');
    const description = extractXmlTag(chunk, 'description');
    // Google News RSS puts source name in <source> tag
    const sourceMatch = chunk.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
    const sourceUrl = sourceMatch ? sourceMatch[1] : null;
    const sourceName = sourceMatch ? cleanXml(sourceMatch[2]) : extractDomain(link);

    if (title) {
      items.push({
        title: cleanXml(title),
        url: cleanXml(link) || sourceUrl,
        publishedAt: pubDate ? new Date(pubDate) : new Date(),
        sourceName: sourceName || 'Web',
        sourceUrl: sourceUrl || cleanXml(link),
        summary: cleanXml(description)
      });
    }
  }
  return items;
}

function extractXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function cleanXml(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractDomain(url) {
  if (!url) return 'Web';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Web'; }
}

// Deduplicate articles across multiple query results
// Same URL → keep once; very similar titles (fuzzy) → keep highest-quality source
function deduplicateArticles(articles) {
  const seen = new Map(); // url → article
  const titleSeen = new Map(); // normalized title → article

  for (const article of articles) {
    const url = (article.url || '').toLowerCase().split('?')[0];
    const normTitle = (article.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().substring(0, 80);

    // Deduplicate by URL
    if (url && url.length > 10) {
      const existing = seen.get(url);
      if (!existing || article.qualityScore > existing.qualityScore) {
        seen.set(url, article);
      }
      continue;
    }

    // Deduplicate by title similarity
    if (normTitle) {
      const existing = titleSeen.get(normTitle);
      if (!existing || article.qualityScore > existing.qualityScore) {
        titleSeen.set(normTitle, article);
      }
    }
  }

  const byUrl = Array.from(seen.values());
  const byTitle = Array.from(titleSeen.values()).filter(a => {
    const url = (a.url || '').toLowerCase().split('?')[0];
    return !url || !seen.has(url);
  });

  return [...byUrl, ...byTitle];
}

// Match an article against trigger rules — returns best matching rule + score
function matchArticleToRules(article, rules) {
  const text = `${article.title || ''} ${article.summary || ''}`.toLowerCase();
  let bestRule = null;
  let bestScore = 0;

  for (const rule of rules) {
    const keywords = rule.keywords || [];
    const matched = keywords.filter(kw => text.includes(kw.toLowerCase()));
    if (matched.length > 0) {
      const ruleScore = rule.score_weight * matched.length;
      if (ruleScore > bestScore) {
        bestScore = ruleScore;
        bestRule = rule;
      }
    }
  }
  return { rule: bestRule, baseScore: bestScore };
}

// Build the multi-query search plan for a prospect
function buildSearchQueries(prospect) {
  const name = prospect.name;
  const company = prospect.company || '';
  const queries = [];

  // Core name queries
  queries.push(`"${name}"`);
  queries.push(`"${name}" yacht OR superyacht OR boat`);
  queries.push(`"${name}" sold company OR exit OR IPO OR acquisition`);
  queries.push(`"${name}" funding OR investment OR "raised"`);

  // Luxury wealth signals
  queries.push(`"${name}" Monaco OR "Cannes" OR "boat show" OR "Fort Lauderdale"`);
  queries.push(`"${name}" Forbes OR Bloomberg OR "net worth" OR billionaire`);
  queries.push(`"${name}" luxury OR "private jet" OR "real estate" OR "art auction"`);

  // Yacht-specific
  queries.push(`"${name}" superyacht OR megayacht OR charter`);

  // Company-level signals (if company known)
  if (company) {
    queries.push(`"${company}" acquisition OR merger OR IPO OR funding`);
    queries.push(`"${company}" revenue OR "company sold" OR exit`);
  }

  return queries;
}

// Main scanner — replaces the stub with real live searches
async function scanProspect(prospect, scanType = 'manual') {
  const scanStart = new Date();
  let signalsFound = 0;

  try {
    // Get active trigger rules
    const { rows: rules } = await pool.query('SELECT * FROM trigger_rules WHERE is_active = TRUE');

    // Determine search depth based on heat tier
    const tier = (prospect.heat_tier || 'cold').toLowerCase();
    const maxPerQuery = tier === 'hot' ? 20 : tier === 'warm' ? 10 : 5;

    // Build queries
    const searchQueries = buildSearchQueries(prospect);

    console.log(`[Scanner] ${prospect.name} (${tier}) — running ${searchQueries.length} queries, ${maxPerQuery} results each`);

    // Fetch all articles in parallel (batches of 4 to avoid hammering)
    const allRawArticles = [];
    const batchSize = 4;
    for (let i = 0; i < searchQueries.length; i += batchSize) {
      const batch = searchQueries.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(q => fetchGoogleNewsRSS(q, maxPerQuery))
      );
      batchResults.forEach(articles => allRawArticles.push(...articles));
      // Small courtesy delay between batches
      if (i + batchSize < searchQueries.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    console.log(`[Scanner] ${prospect.name} — fetched ${allRawArticles.length} raw articles`);

    // Annotate each article with quality score before dedup
    const annotated = allRawArticles.map(a => ({
      ...a,
      qualityScore: getSourceMultiplier(a.sourceName, a.url)
    }));

    // Deduplicate
    const unique = deduplicateArticles(annotated);
    console.log(`[Scanner] ${prospect.name} — ${unique.length} unique articles after dedup`);

    // Get existing signals to avoid duplicate DB entries (last 14 days)
    const { rows: recentSignals } = await pool.query(
      `SELECT source_url, title FROM prospect_signals
       WHERE prospect_id = $1 AND detected_at > NOW() - INTERVAL '14 days'`,
      [prospect.id]
    );
    const recentUrls = new Set(recentSignals.map(s => (s.source_url || '').toLowerCase().split('?')[0]).filter(Boolean));
    const recentTitles = new Set(recentSignals.map(s => (s.title || '').toLowerCase().substring(0, 80)));

    // Process each unique article
    for (const article of unique) {
      // Skip if already stored recently
      const artUrl = (article.url || '').toLowerCase().split('?')[0];
      const artTitle = (article.title || '').toLowerCase().substring(0, 80);
      if ((artUrl && recentUrls.has(artUrl)) || (artTitle && recentTitles.has(artTitle))) continue;

      // Match to trigger rules
      const { rule, baseScore } = matchArticleToRules(article, rules);

      // Only save if it matches a rule OR comes from a premium source with "yacht" content
      const isYachtSource = getSourceMultiplier(article.sourceName, article.url) >= 2.0;
      const isYachtContent = /(yacht|superyacht|megayacht|charter|boat show|FLIBS|Monaco Yacht|Cannes Yachting)/i.test(article.title + article.summary);
      const isPremiumSource = getSourceMultiplier(article.sourceName, article.url) >= 1.5;

      if (!rule && !(isYachtSource && isYachtContent) && !isPremiumSource) continue;

      // Calculate final score
      const multiplier = getSourceMultiplier(article.sourceName, article.url);
      const rawScore = rule ? rule.score_weight : (isYachtContent ? 3 : 2);
      const finalScore = Math.round(rawScore * multiplier);

      // Determine signal type
      const signalType = rule ? rule.category : (isYachtContent ? 'low' : 'medium');

      // Build title (concise, signal-forward)
      const signalTitle = article.title.length > 120
        ? article.title.substring(0, 117) + '...'
        : article.title;

      // Build summary
      const publishedStr = article.publishedAt
        ? new Date(article.publishedAt).toISOString().slice(0, 10)
        : '';
      const signalSummary = [
        article.summary ? article.summary.substring(0, 300) : '',
        `Source: ${article.sourceName}`,
        publishedStr ? `Published: ${publishedStr}` : ''
      ].filter(Boolean).join(' | ');

      await pool.query(
        `INSERT INTO prospect_signals
           (prospect_id, trigger_rule_id, signal_type, title, summary, source_url, source_name, score, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          prospect.id,
          rule ? rule.id : null,
          signalType,
          signalTitle,
          signalSummary,
          article.url || null,
          article.sourceName,
          finalScore,
          JSON.stringify({ multiplier, publishedAt: article.publishedAt })
        ]
      );

      // Track in local sets to avoid double-inserting within this scan run
      if (artUrl) recentUrls.add(artUrl);
      if (artTitle) recentTitles.add(artTitle);
      signalsFound++;
    }

    // Update last scanned timestamp
    await pool.query(
      'UPDATE prospects SET last_scanned_at = NOW(), updated_at = NOW() WHERE id = $1',
      [prospect.id]
    );

    // Recalculate heat
    await recalcProspectHeat(prospect.id);

    // Log the scan
    await pool.query(
      `INSERT INTO scan_history (prospect_id, tenant_id, scan_type, signals_found, search_queries, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', NOW())`,
      [prospect.id, prospect.tenant_id || null, scanType, signalsFound, searchQueries]
    );

    console.log(`[Scanner] ${prospect.name} — done. ${signalsFound} new signals saved.`);
    return { prospect_id: prospect.id, prospect_name: prospect.name, signals_found: signalsFound };

  } catch (err) {
    await pool.query(
      `INSERT INTO scan_history (prospect_id, tenant_id, scan_type, signals_found, status, error_message, completed_at)
       VALUES ($1, $2, $3, 0, 'failed', $4, NOW())`,
      [prospect.id, prospect.tenant_id || null, scanType, err.message]
    ).catch(() => {});
    throw err;
  }
}

// ─── OUTREACH: Generate personalised email + LinkedIn message per prospect ────
app.post('/api/prospects/:id/outreach', requireAuth, async (req, res) => {
  try {
    const prospectId = req.params.id;

    // 1. Fetch prospect
    const { rows: prospects } = await pool.query('SELECT * FROM prospects WHERE id = $1', [prospectId]);
    if (prospects.length === 0) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const prospect = prospects[0];

    // 2. Fetch top signals for this prospect (the actual events that triggered HOT status)
    const { rows: signals } = await pool.query(
      `SELECT ps.title, ps.summary, ps.signal_type, ps.source_name, ps.detected_at, ps.score, tr.name as trigger_name
       FROM prospect_signals ps
       LEFT JOIN trigger_rules tr ON ps.trigger_rule_id = tr.id
       WHERE ps.prospect_id = $1
       ORDER BY ps.score DESC, ps.detected_at DESC
       LIMIT 6`,
      [prospectId]
    );

    // 3. Find matching yachts
    const { rows: yachts } = await pool.query(
      'SELECT * FROM yachts WHERE is_active = TRUE ORDER BY price DESC NULLS LAST'
    );

    // Score yachts against prospect preferences
    const scored = yachts.map(yacht => {
      let score = 0;
      const reasons = [];

      if (prospect.yacht_brand) {
        const brands = prospect.yacht_brand.split(/[,;\/]/).map(b => b.trim().toLowerCase()).filter(Boolean);
        const builderLow = (yacht.builder || '').toLowerCase();
        const nameLow = (yacht.name || '').toLowerCase();
        if (brands.some(b => builderLow.includes(b) || b.includes(builderLow) || nameLow.includes(b))) {
          score += 35;
          reasons.push(`${yacht.builder || yacht.name} matches brand preference`);
        }
      }

      if (prospect.yacht_model && yacht.name) {
        if (yacht.name.toLowerCase().includes(prospect.yacht_model.toLowerCase()) ||
            prospect.yacht_model.toLowerCase().includes(yacht.name.toLowerCase())) {
          score += 25;
          reasons.push(`${yacht.name} matches preferred model`);
        }
      }

      if (prospect.current_yacht_interest) {
        const interest = prospect.current_yacht_interest.toLowerCase();
        const yachtText = `${yacht.builder || ''} ${yacht.name || ''} ${yacht.location_text || ''}`.toLowerCase();
        const words = interest.split(/\s+/).filter(w => w.length > 3);
        const matches = words.filter(w => yachtText.includes(w));
        if (matches.length > 0) {
          score += matches.length * 5;
          reasons.push(`Matches interest in "${prospect.current_yacht_interest}"`);
        }
      }

      if (yacht.is_approved) {
        score += 5;
        reasons.push('Approved listing');
      }

      return { ...yacht, match_score: score, match_reasons: reasons };
    });

    const topMatches = scored.sort((a, b) => b.match_score - a.match_score).slice(0, 3);

    const yachtSummary = topMatches.map((y, i) => {
      const priceStr = y.price ? `${y.currency || '€'}${Number(y.price).toLocaleString('fr-FR')}` : 'Price on request';
      return `${i + 1}. ${y.builder || ''}${y.name ? ' ' + y.name : ''} — ${y.length || '?'}m — ${priceStr} — Location: ${y.location_text || 'TBD'} — Built: ${y.year_built || 'N/A'}${y.year_refit ? ` / Refit: ${y.year_refit}` : ''}${y.brokers ? ` — Brokers: ${y.brokers}` : ''}`;
    }).join('\n');

    // 4. Build signal context and tier-specific prompt instructions
    const prospectTier = (prospect.heat_tier || 'cold').toUpperCase();
    const signalContext = signals.length > 0
      ? signals.map(s => {
          const date = s.detected_at ? new Date(s.detected_at).toISOString().slice(0, 10) : '';
          return `- [${s.signal_type || s.trigger_name || 'Signal'}] "${s.title}"${s.summary ? ': ' + s.summary : ''}${date ? ` (${date})` : ''}`;
        }).join('\n')
      : '- No specific signals detected yet — use general luxury wealth context';

    const signalSectionHeader = signals.length > 0
      ? `INTELLIGENCE SIGNALS (${prospectTier} prospect — reference these specifically):`
      : `PROSPECT CONTEXT (${prospectTier} prospect — no signals yet; reference their profile, yacht interest, company, or location instead):`;

    const linkedinPieceInstruction = signals.length > 0
      ? `- Directly reference the most impactful signal (e.g., "Congratulations on your recent exit…", "Saw your appearance at Monaco Yacht Show…", "Congrats on the new role at…")`
      : `- Reference their profile context: yacht interest (${prospect.current_yacht_interest || 'luxury yachts'}), company (${prospect.company || 'their industry'}), or location (${prospect.location || 'their region'}) — make it feel researched and personal, not cold`;

    const firstName = prospect.name ? prospect.name.split(' ')[0] : 'there';

    // 5. Generate 3-message outreach suite in one AI call (adapts to HOT/WARM/COLD tier)
    const prompt = `You are a senior copywriter for Barnes Yachting, a luxury yacht brokerage in Marseille/Monaco. You write elegant, high-touch outreach for ultra-high-net-worth individuals. Never sound generic or salesy.

PROSPECT:
- Name: ${prospect.name}
- Company: ${prospect.company || 'N/A'}
- Location: ${prospect.location || 'N/A'}
- Yacht Interest: ${prospect.current_yacht_interest || 'Luxury yachts'}
- Preferred Brand: ${prospect.yacht_brand || 'N/A'}
- Notes: ${prospect.notes || 'N/A'}
- Prospect Tier: ${prospectTier}

${signalSectionHeader}
${signalContext}

MATCHING INVENTORY (reference at least one yacht in the emails):
${yachtSummary || 'No exact matches — reference our Marseille/Monaco-based luxury fleet'}

Generate THREE pieces of outreach tailored to this prospect's tier. Return ONLY valid JSON (no markdown).

PIECE 1 — LinkedIn Intro Message:
- MAX 280 characters (hard limit — count carefully)
- Warm and personal, not salesy
${linkedinPieceInstruction}
- First-name basis (use "${firstName}")
- End with a gentle hook, not a hard ask

PIECE 2 — Follow-Up Email #1 (Day 3 — sent 3 days after LinkedIn):
- Subject line + body (150-220 words)
- Assumes they saw the LinkedIn message but haven't responded
- Build on the same signal context — go slightly deeper
- Introduce Barnes Yachting value prop naturally
- Reference a specific yacht from inventory that fits their profile
- Tone: Robb Report level — informed, elegant, respectful of their time
- Sign off: "Warmly,\nThe Barnes Yachting Team"

PIECE 3 — Follow-Up Email #2 (Day 10 — 10 days after LinkedIn):
- Subject line + body (120-180 words)
- Warmer tone — acknowledge you've reached out before, no pressure
- Reference their previous signals and any new context
- Offer a specific next step: private yacht viewing, charter experience, or 15-min call
- Light and confident — make it easy to say yes
- Sign off: "Warmly,\nThe Barnes Yachting Team"

Return this exact JSON:
{
  "linkedin_message": "...",
  "followup_day3_subject": "...",
  "followup_day3_body": "...",
  "followup_day10_subject": "...",
  "followup_day10_body": "..."
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a luxury yacht brokerage copywriter. Return only valid JSON, no markdown, no code fences.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.72,
      response_format: { type: 'json_object' }
    });

    // Parse response
    let raw = completion.choices[0].message.content || '';
    raw = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      let fixed = raw;
      let inStr = false;
      for (let i = 0; i < fixed.length; i++) {
        if (fixed[i] === '"' && (i === 0 || fixed[i-1] !== '\\')) inStr = !inStr;
      }
      if (inStr) fixed += '"';
      fixed = fixed.replace(/,\s*$/, '');
      let open = 0;
      for (const ch of fixed) { if (ch === '{') open++; if (ch === '}') open--; }
      while (open > 0) { fixed += '}'; open--; }
      try { parsed = JSON.parse(fixed); } catch (e2) {
        parsed = {
          linkedin_message: `Hi ${firstName}, following your recent news — we have a yacht in our Marseille fleet that I think you'd appreciate. Would love to connect.`,
          followup_day3_subject: `A yacht curated for you, ${firstName}`,
          followup_day3_body: `Dear ${firstName},\n\nI hope this finds you well. Following up on my LinkedIn message — I wanted to share something specific from our current inventory that I believe aligns closely with your interests.\n\nWe recently listed a vessel that fits your profile remarkably well. I'd welcome the chance to walk you through it at your convenience.\n\nWarmly,\nThe Barnes Yachting Team`,
          followup_day10_subject: `Still here if the timing is right`,
          followup_day10_body: `Dear ${firstName},\n\nI know your schedule is demanding — no pressure at all. I just wanted to leave this door open.\n\nWhen the moment is right, I'd love to offer you a private viewing or a charter day aboard one of our flagships. No commitment, just the experience.\n\nWarmly,\nThe Barnes Yachting Team`
        };
      }
    }

    // Enforce LinkedIn 280-char limit
    if (parsed.linkedin_message && parsed.linkedin_message.length > 280) {
      parsed.linkedin_message = parsed.linkedin_message.slice(0, 277) + '...';
    }

    res.json({
      success: true,
      prospect: { id: prospect.id, name: prospect.name, company: prospect.company, heat_tier: prospect.heat_tier },
      signals: signals.map(s => ({ title: s.title, signal_type: s.signal_type, detected_at: s.detected_at, score: s.score })),
      matched_yachts: topMatches.map(y => ({
        id: y.id, name: y.name, builder: y.builder, length: y.length,
        price: y.price, currency: y.currency, location_text: y.location_text,
        year_built: y.year_built, year_refit: y.year_refit,
        brokers: y.brokers, is_approved: y.is_approved, match_score: y.match_score,
        image_url: y.image_url
      })),
      // Legacy fields (for backward compat with existing code)
      email_subject: parsed.followup_day3_subject || '',
      email_body: parsed.followup_day3_body || '',
      linkedin_message: parsed.linkedin_message || '',
      // New 3-message suite
      followup_day3_subject: parsed.followup_day3_subject || '',
      followup_day3_body: parsed.followup_day3_body || '',
      followup_day10_subject: parsed.followup_day10_subject || '',
      followup_day10_body: parsed.followup_day10_body || ''
    });

  } catch (err) {
    console.error('Error generating outreach:', err.message);
    res.status(500).json({ success: false, message: 'Failed to generate outreach messages' });
  }
});

// ─── OUTREACH: Send follow-up email to prospect ───────────────────────────────
app.post('/api/prospects/:id/send-email', requireAuth, async (req, res) => {
  try {
    const prospectId = req.params.id;
    const { template_type, subject, body } = req.body;

    if (!template_type || !subject || !body) {
      return res.status(400).json({ success: false, message: 'template_type, subject, and body are required' });
    }

    const validTypes = ['followup_day3', 'followup_day10'];
    if (!validTypes.includes(template_type)) {
      return res.status(400).json({ success: false, message: 'template_type must be followup_day3 or followup_day10' });
    }

    // Fetch prospect
    const { rows: prospects } = await pool.query('SELECT id, name, email FROM prospects WHERE id = $1', [prospectId]);
    if (prospects.length === 0) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const prospect = prospects[0];

    if (!prospect.email) {
      return res.status(400).json({ success: false, message: 'Prospect has no email address on file' });
    }

    // Convert plain text body to HTML
    const htmlBody = body.split('\n').map(line =>
      line.trim() === '' ? '<br>' : `<p style="margin:0 0 10px;line-height:1.7;font-family:-apple-system,Georgia,serif;font-size:15px;color:#1a1a1a;">${line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`
    ).join('');

    const htmlEmail = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#fff;padding:40px 30px;max-width:600px;margin:0 auto;">
  <div style="border-bottom:2px solid #c9a96e;padding-bottom:16px;margin-bottom:28px;">
    <span style="font-family:Georgia,serif;font-size:20px;font-weight:700;color:#1a1a1a;letter-spacing:1px;">BARNES YACHTING</span>
    <span style="font-family:-apple-system,sans-serif;font-size:11px;color:#888;margin-left:12px;letter-spacing:2px;text-transform:uppercase;">Monaco · Marseille</span>
  </div>
  ${htmlBody}
  <div style="border-top:1px solid #e8e0d0;margin-top:32px;padding-top:16px;">
    <p style="font-family:-apple-system,sans-serif;font-size:12px;color:#aaa;margin:0;">Barnes Yachting · 2 Quai des Belges, Marseille · Monaco Yacht Club</p>
  </div>
</body>
</html>`;

    // Send via Polsia email proxy
    const emailRes = await fetch('https://polsia.com/api/proxy/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.POLSIA_API_KEY}`
      },
      body: JSON.stringify({
        to: prospect.email,
        subject,
        body,
        html: htmlEmail,
        transactional: false  // cold outreach — not transactional
      })
    });

    const emailResult = await emailRes.json();

    if (!emailRes.ok) {
      console.error('[EMAIL OUTREACH] Failed to send:', emailResult);
      return res.status(500).json({ success: false, message: 'Failed to send email: ' + (emailResult.error || emailResult.message || 'Unknown error') });
    }

    console.log(`[EMAIL OUTREACH] Sent ${template_type} to ${prospect.email} (Prospect #${prospectId})`);

    // Log to database
    await pool.query(
      `INSERT INTO outreach_emails (prospect_id, template_type, subject, body, sent_from)
       VALUES ($1, $2, $3, $4, 'barnesos@polsia.app')`,
      [prospectId, template_type, subject, body]
    );

    res.json({ success: true, message: `Email sent to ${prospect.email}` });

  } catch (err) {
    console.error('Error sending outreach email:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

// ─── Heat Score Recalculation ────────────────────────────────────────────────
async function recalcProspectHeat(prospectId) {
  try {
    // Fetch all signals from the last 90 days with their detected_at timestamps
    const { rows: signals } = await pool.query(
      `SELECT score, detected_at
       FROM prospect_signals
       WHERE prospect_id = $1 AND detected_at > NOW() - INTERVAL '90 days'
       ORDER BY detected_at DESC`,
      [prospectId]
    );

    // Apply 3-tier time decay:
    //   0-30 days  → 100% weight
    //   30-90 days → 50% weight
    //   >90 days   → 0% (already excluded by query)
    const now = Date.now();
    let totalScore = 0;
    for (const sig of signals) {
      const ageDays = (now - new Date(sig.detected_at).getTime()) / (1000 * 60 * 60 * 24);
      const weight = ageDays <= 30 ? 1.0 : 0.5;
      totalScore += Math.round(sig.score * weight);
    }

    // Tier thresholds: HOT ≥15 pts, WARM 6-14 pts, COLD 0-5 pts
    let tier = 'cold';
    if (totalScore >= 15) tier = 'hot';
    else if (totalScore >= 6) tier = 'warm';

    await pool.query(
      'UPDATE prospects SET heat_score = $1, heat_tier = $2, updated_at = NOW() WHERE id = $3',
      [totalScore, tier, prospectId]
    );
  } catch (err) {
    console.error('Error recalculating heat:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// PAGE SERVING
// ═══════════════════════════════════════════════════════════════════════════════

// Serve landing page for root (requires auth)
// ═══════════════════════════════════════════════════════════════════════════════
// COCKPIT — Top bar stats + Fund entries + Outreach chains
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Cockpit page routes (all served by cockpit.html) ────────────────────────
const cockpitHtmlPath = path.join(__dirname, 'public', 'cockpit.html');
function serveCockpit(req, res) {
  if (fs.existsSync(cockpitHtmlPath)) {
    res.type('html').sendFile(cockpitHtmlPath);
  } else {
    res.status(404).json({ message: 'Cockpit not found' });
  }
}
app.get('/cockpit', requireAuth, serveCockpit);
app.get('/cockpit/radar', requireAuth, serveCockpit);
app.get('/cockpit/matchmaker', requireAuth, serveCockpit);
app.get('/cockpit/fund', requireAuth, serveCockpit);

// ─── API: Cockpit top bar stats ───────────────────────────────────────────────
app.get('/api/cockpit/stats', async (req, res) => {
  try {
    const FUND_TARGET = 30_000_000;

    const [hotRes, chainsRes, fundRes, signalRes] = await Promise.all([
      // 1. Hot prospects count
      pool.query(`SELECT COUNT(*) AS count FROM prospects WHERE heat_tier = 'hot'`),

      // 2. Active outreach chains: has ≥1 sent step, no replied step, ≥1 pending step
      pool.query(`
        SELECT COUNT(DISTINCT oc.id) AS count
        FROM outreach_chains oc
        WHERE EXISTS (
          SELECT 1 FROM outreach_chain_steps s WHERE s.chain_id = oc.id AND s.status = 'sent'
        )
        AND NOT EXISTS (
          SELECT 1 FROM outreach_chain_steps s WHERE s.chain_id = oc.id AND s.status = 'replied'
        )
        AND EXISTS (
          SELECT 1 FROM outreach_chain_steps s WHERE s.chain_id = oc.id AND s.status = 'pending'
        )
      `),

      // 3. Fund confirmed capital (hard_commit + wired)
      pool.query(`
        SELECT COALESCE(SUM(amount_eur), 0) AS total
        FROM fund_entries WHERE status IN ('hard_commit','wired')
      `),

      // 4. Most recent signal
      pool.query(`
        SELECT ps.signal_type, ps.detected_at, p.name AS prospect_name, p.id AS prospect_id
        FROM prospect_signals ps
        JOIN prospects p ON p.id = ps.prospect_id
        ORDER BY ps.detected_at DESC
        LIMIT 1
      `)
    ]);

    const fundTotal = parseFloat(fundRes.rows[0].total) || 0;
    const pct = fundTotal / FUND_TARGET * 100;
    const fundMillion = fundTotal / 1_000_000;

    res.json({
      success: true,
      hot_prospects: parseInt(hotRes.rows[0].count) || 0,
      active_chains: parseInt(chainsRes.rows[0].count) || 0,
      fund: {
        total_eur: fundTotal,
        percentage: parseFloat(pct.toFixed(1)),
        formatted: `€${fundMillion.toFixed(1)}M / ${pct.toFixed(1)}%`
      },
      last_signal: signalRes.rows[0] ? {
        prospect_name: signalRes.rows[0].prospect_name,
        prospect_id: signalRes.rows[0].prospect_id,
        signal_type: signalRes.rows[0].signal_type,
        detected_at: signalRes.rows[0].detected_at
      } : null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── API: Fund entries ────────────────────────────────────────────────────────
app.get('/api/fund/entries', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM fund_entries ORDER BY committed_at DESC, created_at DESC`
    );
    const total = rows.reduce((s, r) => s + (parseFloat(r.amount_eur) || 0), 0);
    const confirmed = rows
      .filter(r => r.status === 'hard_commit' || r.status === 'wired')
      .reduce((s, r) => s + (parseFloat(r.amount_eur) || 0), 0);
    res.json({ success: true, entries: rows, total_eur: total, confirmed_eur: confirmed });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/fund/entries', async (req, res) => {
  try {
    const { investor_name, amount_eur, status = 'soft_commit', notes, committed_at } = req.body;
    if (!investor_name || !amount_eur) {
      return res.status(400).json({ success: false, message: 'investor_name and amount_eur required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO fund_entries (investor_name, amount_eur, status, notes, committed_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [investor_name, parseFloat(amount_eur), status, notes || null,
       committed_at || new Date().toISOString().split('T')[0]]
    );
    res.json({ success: true, entry: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/fund/entries/:id', async (req, res) => {
  try {
    const { investor_name, amount_eur, status, notes, committed_at } = req.body;
    const { rows } = await pool.query(
      `UPDATE fund_entries SET
         investor_name = COALESCE($1, investor_name),
         amount_eur    = COALESCE($2, amount_eur),
         status        = COALESCE($3, status),
         notes         = COALESCE($4, notes),
         committed_at  = COALESCE($5, committed_at),
         updated_at    = NOW()
       WHERE id = $6 RETURNING *`,
      [investor_name || null, amount_eur ? parseFloat(amount_eur) : null,
       status || null, notes !== undefined ? notes : null,
       committed_at || null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Entry not found' });
    res.json({ success: true, entry: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/fund/entries/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM fund_entries WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: 'Entry not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── API: Outreach chains ─────────────────────────────────────────────────────
app.get('/api/outreach/chains', async (req, res) => {
  try {
    const { prospect_id, status } = req.query;
    const params = [];
    let where = '';

    if (prospect_id) { params.push(prospect_id); where += ` AND oc.prospect_id = $${params.length}`; }

    const { rows: chains } = await pool.query(
      `SELECT oc.*, p.name AS prospect_name, p.heat_tier, p.company AS prospect_company,
              (SELECT json_agg(s ORDER BY s.step_number) FROM outreach_chain_steps s WHERE s.chain_id = oc.id) AS steps,
              (SELECT COUNT(*) FROM outreach_chain_steps s WHERE s.chain_id = oc.id AND s.status = 'sent') AS sent_count,
              (SELECT COUNT(*) FROM outreach_chain_steps s WHERE s.chain_id = oc.id AND s.status = 'replied') AS replied_count,
              (SELECT COUNT(*) FROM outreach_chain_steps s WHERE s.chain_id = oc.id AND s.status = 'pending') AS pending_count
       FROM outreach_chains oc
       JOIN prospects p ON p.id = oc.prospect_id
       WHERE 1=1 ${where}
       ORDER BY oc.updated_at DESC`,
      params
    );

    let filtered = chains;
    if (status === 'active') {
      filtered = chains.filter(c =>
        parseInt(c.sent_count) > 0 &&
        parseInt(c.replied_count) === 0 &&
        parseInt(c.pending_count) > 0
      );
    } else if (status === 'replied') {
      filtered = chains.filter(c => parseInt(c.replied_count) > 0);
    } else if (status === 'completed') {
      filtered = chains.filter(c => parseInt(c.pending_count) === 0);
    }

    res.json({ success: true, chains: filtered, count: filtered.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/outreach/chains', async (req, res) => {
  try {
    const { prospect_id, title, notes, steps = [] } = req.body;
    if (!prospect_id) return res.status(400).json({ success: false, message: 'prospect_id required' });

    const chainRes = await pool.query(
      `INSERT INTO outreach_chains (prospect_id, title, notes) VALUES ($1, $2, $3) RETURNING *`,
      [prospect_id, title || null, notes || null]
    );
    const chain = chainRes.rows[0];

    for (const step of steps) {
      await pool.query(
        `INSERT INTO outreach_chain_steps (chain_id, step_number, channel, subject, body, scheduled_for)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [chain.id, step.step_number || 1, step.channel || 'email',
         step.subject || null, step.body || null, step.scheduled_for || null]
      );
    }

    res.json({ success: true, chain });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/outreach/chains/:id/steps', async (req, res) => {
  try {
    const { step_number, channel = 'email', subject, body, scheduled_for } = req.body;
    const { rows: existingRows } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM outreach_chain_steps WHERE chain_id = $1', [req.params.id]
    );
    const stepNum = step_number || (parseInt(existingRows[0]?.cnt || 0) + 1);
    const { rows } = await pool.query(
      `INSERT INTO outreach_chain_steps (chain_id, step_number, channel, subject, body, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, stepNum, channel, subject || null, body || null, scheduled_for || null]
    );
    await pool.query('UPDATE outreach_chains SET updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ success: true, step: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/outreach/chains/:chainId/steps/:stepId', async (req, res) => {
  try {
    const { status, sent_at, replied_at } = req.body;
    const updates = [];
    const params = [];

    if (status) { params.push(status); updates.push(`status = $${params.length}`); }
    if (status === 'sent' && !sent_at) { updates.push(`sent_at = NOW()`); }
    else if (sent_at) { params.push(sent_at); updates.push(`sent_at = $${params.length}`); }
    if (status === 'replied' && !replied_at) { updates.push(`replied_at = NOW()`); }
    else if (replied_at) { params.push(replied_at); updates.push(`replied_at = $${params.length}`); }
    updates.push(`updated_at = NOW()`);

    params.push(req.params.stepId, req.params.chainId);
    const { rows } = await pool.query(
      `UPDATE outreach_chain_steps SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND chain_id = $${params.length} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Step not found' });

    // bump chain updated_at
    await pool.query(`UPDATE outreach_chains SET updated_at = NOW() WHERE id = $1`, [req.params.chainId]);
    res.json({ success: true, step: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/outreach/chains/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM outreach_chains WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: 'Chain not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Sync outreach_emails → outreach_chains (one-time import) ────────────────
// Converts legacy outreach_emails rows into chain+step records
app.post('/api/outreach/import-legacy', async (req, res) => {
  try {
    const { rows: emails } = await pool.query(
      `SELECT * FROM outreach_emails ORDER BY created_at ASC`
    );

    let imported = 0;
    for (const email of emails) {
      // Create chain per prospect (one chain per email for now)
      const chainRes = await pool.query(
        `INSERT INTO outreach_chains (prospect_id, title, created_at, updated_at)
         VALUES ($1, $2, $3, $3) RETURNING id`,
        [email.prospect_id, `Legacy: ${email.template_type || 'email'}`, email.created_at]
      );
      await pool.query(
        `INSERT INTO outreach_chain_steps (chain_id, step_number, channel, subject, body, status, sent_at)
         VALUES ($1, 1, 'email', $2, $3, 'sent', $4)`,
        [chainRes.rows[0].id, email.subject || null, email.body || null, email.created_at]
      );
      imported++;
    }
    res.json({ success: true, imported });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'command-center.html');
  if (fs.existsSync(htmlPath)) {
    res.type('html').sendFile(htmlPath);
  } else {
    res.redirect('/command-center');
  }
});

// Serve Matchmaker page (requires auth — accepts both regular and broker session)
app.get('/matchmaker', (req, res) => {
  const isAuth = (req.session && req.session.authenticated) || (req.session && req.session.brokerUser);
  if (!isAuth) return res.redirect('/broker/login');
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.type('html').sendFile(htmlPath);
  } else {
    res.status(404).json({ message: 'Matchmaker not found' });
  }
});

// Serve Matchmaker via broker portal (broker auth)
app.get('/broker/matchmaker', (req, res) => {
  if (!req.session || !req.session.brokerUser) return res.redirect('/broker/login');
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.type('html').sendFile(htmlPath);
  } else {
    res.status(404).json({ message: 'Matchmaker not found' });
  }
});

// Serve deal flow tracker admin page (requires auth)
app.get('/deals', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'deals.html');
  if (fs.existsSync(htmlPath)) {
    res.type('html').sendFile(htmlPath);
  } else {
    res.status(404).json({ message: 'Deal flow tracker not found' });
  }
});

// Serve Command Center (requires auth)
app.get('/command-center', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'command-center.html');
  if (fs.existsSync(htmlPath)) {
    res.type('html').sendFile(htmlPath);
  } else {
    res.status(404).json({ message: 'Command Center not found' });
  }
});

// ─── BROKER PORTAL PAGES ─────────────────────────────────────────────────────

// ── Branding helpers ──────────────────────────────────────────────────────────
function getBrandColor(tenant) {
  return (tenant && tenant.primary_color) || '#c9a84c';
}

function getDisplayName(tenant) {
  return (tenant && (tenant.company_display_name || tenant.name)) || 'Portal';
}

// Inject brand color CSS override block
function brandColorStyles(tenant) {
  const color = getBrandColor(tenant);
  return `<style>
    :root { --brand: ${color}; --brand-dim: ${color}99; }
    .btn-primary, button.btn-primary { background: ${color} !important; color: #0f172a !important; }
    a.brand-link { color: ${color} !important; }
    .brand-text { color: ${color} !important; }
    .topbar-brand { color: ${color} !important; }
    input:focus { border-color: ${color} !important; }
  </style>`;
}

// Render logo HTML for topbar (image if set, text otherwise)
function topbarLogoHtml(tenant, size = 26) {
  const logoUrl = tenant && tenant.logo_url;
  const name = getDisplayName(tenant);
  if (logoUrl) {
    return `<img src="${logoUrl}" alt="${name}" style="height:${size}px;max-width:110px;object-fit:contain;vertical-align:middle;" onerror="this.style.display='none';document.getElementById('topbar-name-fallback').style.display='inline'"><span id="topbar-name-fallback" style="display:none;font-weight:700;color:${getBrandColor(tenant)}">${name}</span>`;
  }
  return `<span class="topbar-brand" style="color:${getBrandColor(tenant)}">${name}</span>`;
}

const BROKER_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 40px; width: 100%; max-width: 440px; }
  .logo { text-align: center; margin-bottom: 32px; }
  .logo h1 { font-size: 22px; font-weight: 700; color: #f1f5f9; letter-spacing: -0.5px; }
  .logo p { font-size: 13px; color: #64748b; margin-top: 4px; }
  .form-group { margin-bottom: 18px; }
  label { display: block; font-size: 13px; font-weight: 500; color: #94a3b8; margin-bottom: 6px; }
  input { width: 100%; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; font-size: 14px; color: #f1f5f9; outline: none; transition: border-color 0.2s; }
  input:focus { border-color: #3b82f6; }
  input::placeholder { color: #475569; }
  .btn { width: 100%; padding: 11px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
  .btn-primary { background: #3b82f6; color: #fff; }
  .btn-primary:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .error { background: #450a0a; border: 1px solid #7f1d1d; color: #fca5a5; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 16px; display: none; }
  .success { background: #052e16; border: 1px solid #14532d; color: #86efac; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 16px; display: none; }
  .link-row { text-align: center; margin-top: 20px; font-size: 13px; color: #64748b; }
  .link-row a { color: #3b82f6; text-decoration: none; }
  .row { display: flex; gap: 12px; }
  .row .form-group { flex: 1; }
  .badge { display: inline-block; background: #1d4ed8; color: #bfdbfe; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-left: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
`;

// brokerPage: renders an auth page (login/signup) with optional tenant branding
// branding = { primary_color, logo_url, company_display_name, name }
function brokerPage(title, body, branding) {
  const bColor = (branding && branding.primary_color) || '#c9a84c';
  const bName = (branding && (branding.company_display_name || branding.name)) || 'Barnes Broker Portal';
  const bLogo = branding && branding.logo_url;
  const brandOverride = branding ? `
  <style>
    .btn-primary { background: ${bColor} !important; color: #0f172a !important; }
    input:focus { border-color: ${bColor} !important; }
    .logo h1 { color: ${bColor}; }
    .link-row a { color: ${bColor} !important; }
  </style>` : '';
  const logoHtml = bLogo ? `<div style="text-align:center;margin-bottom:20px"><img src="${bLogo}" alt="${bName}" style="max-height:52px;max-width:180px;object-fit:contain;"></div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — ${bName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${BROKER_STYLES}</style>
  ${brandOverride}
</head>
<body>${logoHtml ? body.replace('<div class="logo">', '<div class="logo">' + logoHtml) : body}</body>
</html>`;
}

// GET /broker/login
app.get('/broker/login', (req, res) => {
  if (req.session && req.session.brokerUser) return res.redirect('/broker/dashboard');
  res.send(brokerPage('Sign In', `
  <div class="card">
    <div class="logo">
      <h1>Barnes Broker Portal</h1>
      <p>Sign in to your workspace</p>
    </div>
    <div class="error" id="err"></div>
    <div class="form-group">
      <label>Email</label>
      <input type="email" id="email" placeholder="broker@yourfirm.com" autofocus>
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="password" placeholder="••••••••">
    </div>
    <div class="form-group" id="slug-group" style="display:none">
      <label>Workspace Slug <span style="color:#64748b;font-weight:400">(if multiple workspaces)</span></label>
      <input type="text" id="slug" placeholder="my-firm">
    </div>
    <button class="btn btn-primary" id="login-btn" onclick="doLogin()">Sign In</button>
    <div class="link-row">
      New firm? <a href="/broker/signup">Create workspace</a>
      &nbsp;·&nbsp;
      <a href="#" onclick="document.getElementById('slug-group').style.display='block';this.style.display='none'">Multiple workspaces?</a>
    </div>
  </div>
  <script>
    document.querySelectorAll('input').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); }));
    async function doLogin() {
      const btn = document.getElementById('login-btn');
      const err = document.getElementById('err');
      err.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const r = await fetch('/api/broker/login', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            email: document.getElementById('email').value.trim(),
            password: document.getElementById('password').value,
            tenant_slug: document.getElementById('slug').value.trim() || undefined
          })
        });
        const d = await r.json();
        if (d.success) { window.location.href = '/broker/dashboard'; }
        else { err.textContent = d.message; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Sign In'; }
      } catch(e) { err.textContent = 'Network error. Try again.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Sign In'; }
    }
  </script>`));
});

// GET /broker/login/:slug — branded login page for a specific tenant workspace
app.get('/broker/login/:slug', async (req, res) => {
  if (req.session && req.session.brokerUser) return res.redirect('/broker/dashboard');
  const { slug } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, primary_color, logo_url, company_display_name FROM tenants WHERE slug = $1 AND status = 'active'`,
      [slug]
    );
    if (!rows.length) return res.redirect('/broker/login');
    const t = rows[0];
    const displayName = t.company_display_name || t.name;
    res.send(brokerPage('Sign In', `
  <div class="card">
    <div class="logo">
      <h1>${displayName}</h1>
      <p>Sign in to your workspace</p>
    </div>
    <div class="error" id="err"></div>
    <div class="form-group">
      <label>Email</label>
      <input type="email" id="email" placeholder="broker@yourfirm.com" autofocus>
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="password" placeholder="••••••••">
    </div>
    <button class="btn btn-primary" id="login-btn" onclick="doLogin()">Sign In</button>
    <div class="link-row"><a href="/broker/login">Sign in to a different workspace</a></div>
  </div>
  <script>
    document.querySelectorAll('input').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); }));
    async function doLogin() {
      const btn = document.getElementById('login-btn');
      const err = document.getElementById('err');
      err.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const r = await fetch('/api/broker/login', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            email: document.getElementById('email').value.trim(),
            password: document.getElementById('password').value,
            tenant_slug: ${JSON.stringify(slug)}
          })
        });
        const d = await r.json();
        if (d.success) { window.location.href = '/broker/dashboard'; }
        else { err.textContent = d.message; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Sign In'; }
      } catch(e) { err.textContent = 'Network error. Try again.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Sign In'; }
    }
  </script>`, t));
  } catch (err) {
    console.error('[BrandedLogin] Error:', err.message);
    return res.redirect('/broker/login');
  }
});

// GET /broker/signup
app.get('/broker/signup', (req, res) => {
  if (req.session && req.session.brokerUser) return res.redirect('/broker/dashboard');
  res.send(brokerPage('Create Workspace', `
  <div class="card">
    <div class="logo">
      <h1>Create Your Workspace</h1>
      <p>14-day free trial, then €100/month — no card required to start</p>
    </div>
    <div class="error" id="err"></div>
    <div class="form-group">
      <label>Firm / Company Name</label>
      <input type="text" id="tenant_name" placeholder="Riviera Yacht Brokers">
    </div>
    <div class="form-group">
      <label>Workspace Slug <span style="color:#64748b;font-weight:400">(subdomain identifier)</span></label>
      <input type="text" id="slug" placeholder="riviera-yachts" oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9-]/g,'-')">
    </div>
    <div class="row">
      <div class="form-group"><label>First Name</label><input type="text" id="first_name" placeholder="Marie"></div>
      <div class="form-group"><label>Last Name</label><input type="text" id="last_name" placeholder="Dupont"></div>
    </div>
    <div class="form-group"><label>Email</label><input type="email" id="email" placeholder="marie@riviera-yachts.com"></div>
    <div class="form-group"><label>Password</label><input type="password" id="password" placeholder="Min 8 characters"></div>
    <button class="btn btn-primary" id="signup-btn" onclick="doSignup()">Create Workspace</button>
    <div class="link-row">Already have an account? <a href="/broker/login">Sign in</a></div>
  </div>
  <script>
    document.querySelectorAll('input').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') doSignup(); }));
    async function doSignup() {
      const btn = document.getElementById('signup-btn');
      const err = document.getElementById('err');
      err.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        const r = await fetch('/api/broker/signup', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            tenant_name: document.getElementById('tenant_name').value.trim(),
            slug: document.getElementById('slug').value.trim(),
            email: document.getElementById('email').value.trim(),
            password: document.getElementById('password').value,
            first_name: document.getElementById('first_name').value.trim(),
            last_name: document.getElementById('last_name').value.trim()
          })
        });
        const d = await r.json();
        if (d.success) { window.location.href = '/broker/dashboard'; }
        else { err.textContent = d.message; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Create Workspace'; }
      } catch(e) { err.textContent = 'Network error. Try again.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Create Workspace'; }
    }
  </script>`));
});

// GET /broker/accept-invite
app.get('/broker/accept-invite', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/broker/login');
  res.send(brokerPage('Accept Invitation', `
  <div class="card">
    <div class="logo">
      <h1>Accept Your Invitation</h1>
      <p id="invite-subtitle">Loading invitation…</p>
    </div>
    <div class="error" id="err"></div>
    <div id="form-area" style="display:none">
      <div class="row">
        <div class="form-group"><label>First Name</label><input type="text" id="first_name" placeholder="Jean"></div>
        <div class="form-group"><label>Last Name</label><input type="text" id="last_name" placeholder="Martin"></div>
      </div>
      <div class="form-group"><label>Password</label><input type="password" id="password" placeholder="Min 8 characters"></div>
      <button class="btn btn-primary" id="accept-btn" onclick="doAccept()">Set Password & Join</button>
    </div>
  </div>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    (async () => {
      const r = await fetch('/api/broker/invite-info?token=' + TOKEN);
      const d = await r.json();
      if (!d.success) {
        document.getElementById('invite-subtitle').textContent = d.message;
        document.getElementById('err').textContent = d.message;
        document.getElementById('err').style.display = 'block';
        return;
      }
      document.getElementById('invite-subtitle').textContent =
        'You\\'re invited to join ' + d.invite.tenant_name + ' as a ' + d.invite.role;
      document.getElementById('form-area').style.display = 'block';
    })();
    async function doAccept() {
      const btn = document.getElementById('accept-btn');
      const err = document.getElementById('err');
      err.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Joining…';
      try {
        const r = await fetch('/api/broker/accept-invite', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            token: TOKEN,
            password: document.getElementById('password').value,
            first_name: document.getElementById('first_name').value.trim(),
            last_name: document.getElementById('last_name').value.trim()
          })
        });
        const d = await r.json();
        if (d.success) { window.location.href = '/broker/dashboard'; }
        else { err.textContent = d.message; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Set Password & Join'; }
      } catch(e) { err.textContent = 'Network error. Try again.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Set Password & Join'; }
    }
  </script>`));
});

// GET /broker/dashboard — tenant dashboard
app.get('/broker/dashboard', (req, res) => {
  if (!req.session || !req.session.brokerUser) return res.redirect('/broker/login');
  const user = req.session.brokerUser;
  const tenant = req.session.brokerTenant;

  // Compute billing state server-side for initial render
  const billingStatus = effectiveBillingStatus(tenant);
  const daysLeft = trialDaysRemaining(tenant);
  const isReadOnly = billingStatus === 'past_due' || billingStatus === 'cancelled';

  let billingBanner = '';
  if (billingStatus === 'trial' && daysLeft <= 7) {
    billingBanner = `
    <div style="background:#78350f;border:1px solid #b45309;border-radius:8px;padding:14px 20px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <span style="font-size:14px;color:#fde68a">⏰ <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''} left</strong> on your free trial — subscribe to keep full access</span>
      <a href="/broker/billing" style="background:#f59e0b;color:#1c1917;font-size:13px;font-weight:700;padding:7px 18px;border-radius:6px;text-decoration:none">View Billing →</a>
    </div>`;
  } else if (isReadOnly) {
    billingBanner = `
    <div style="background:#450a0a;border:1px solid #b91c1c;border-radius:8px;padding:14px 20px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <span style="font-size:14px;color:#fca5a5">🔒 <strong>Subscription required.</strong> Your workspace is in read-only mode. Data is preserved.</span>
      <a href="/broker/billing" style="background:#ef4444;color:#fff;font-size:13px;font-weight:700;padding:7px 18px;border-radius:6px;text-decoration:none">Subscribe Now →</a>
    </div>`;
  } else if (billingStatus === 'trial') {
    billingBanner = `
    <div style="background:#0c2340;border:1px solid #1d4ed8;border-radius:8px;padding:12px 20px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <span style="font-size:13px;color:#93c5fd">🎁 Free trial active — <strong>${daysLeft} days remaining</strong></span>
      <a href="/broker/billing" style="color:#60a5fa;font-size:13px;font-weight:600;text-decoration:none">Manage billing →</a>
    </div>`;
  }

  const dashBrandColor = getBrandColor(tenant);
  const dashDisplayName = getDisplayName(tenant);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${dashDisplayName} — Broker Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${brandColorStyles(tenant)}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .topbar { background: #1e293b; border-bottom: 1px solid #334155; padding: 0 24px; height: 56px; display: flex; align-items: center; justify-content: space-between; }
    .topbar-left { display: flex; align-items: center; gap: 12px; }
    .topbar h1 { font-size: 16px; font-weight: 700; color: #f1f5f9; }
    .badge { background: #1d4ed8; color: #bfdbfe; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .topbar-right { display: flex; align-items: center; gap: 14px; font-size: 13px; color: #94a3b8; }
    .topbar-right a { color: #64748b; text-decoration: none; }
    .topbar-right a:hover { color: #94a3b8; }
    .main { max-width: 900px; margin: 40px auto; padding: 0 24px; }
    .welcome { margin-bottom: 24px; }
    .welcome h2 { font-size: 24px; font-weight: 700; color: #f1f5f9; }
    .welcome p { color: #64748b; margin-top: 4px; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 20px; }
    .stat label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .stat .value { font-size: 28px; font-weight: 700; color: #f1f5f9; margin-top: 6px; }
    .section { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 24px; margin-bottom: 24px; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .section h3 { font-size: 15px; font-weight: 600; color: #f1f5f9; }
    .btn { padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-primary:hover { opacity: 0.9; }
    .btn-sm { padding: 5px 12px; font-size: 12px; }
    .table { width: 100%; border-collapse: collapse; }
    .table th { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; padding: 8px 12px; text-align: left; border-bottom: 1px solid #334155; }
    .table td { padding: 12px; font-size: 13px; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
    .table tr:last-child td { border-bottom: none; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .pill-admin { background: #312e81; color: #a5b4fc; }
    .pill-broker { background: #164e63; color: #67e8f9; }
    .pill-active { background: #052e16; color: #86efac; }
    .pill-invited { background: #431407; color: #fdba74; }
    .pill-disabled { background: #1c1917; color: #78716c; }
    .invite-form { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
    .invite-form input { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; font-size: 13px; color: #f1f5f9; outline: none; flex: 1; min-width: 180px; }
    .invite-form select { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; font-size: 13px; color: #f1f5f9; outline: none; }
    .invite-link { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 10px 12px; font-size: 12px; color: #94a3b8; font-family: monospace; word-break: break-all; margin-top: 12px; display: none; }
    .copy-btn { cursor: pointer; color: #3b82f6; }
    .error-msg { color: #fca5a5; font-size: 12px; margin-top: 6px; display: none; }
    .readonly-overlay { position: relative; }
    .readonly-overlay::after { content: ''; position: absolute; inset: 0; background: rgba(15,23,42,0.6); border-radius: 10px; pointer-events: all; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="topbar-left">
      ${topbarLogoHtml(tenant, 28)}
      ${!tenant.logo_url ? `<h1 style="color:${dashBrandColor}">${dashDisplayName}</h1>` : ''}
      <span class="badge">${tenant.slug}</span>
    </div>
    <div class="topbar-right">
      <a href="/broker/signal-radar" style="color:${dashBrandColor};font-weight:600">📡 Signal Radar</a>
      ${user.role === 'admin' ? `<a href="/broker/settings/branding" style="color:#94a3b8">⚙ Brand</a>` : ''}
      <a href="/broker/billing" style="color:#60a5fa">Billing</a>
      <span>${user.first_name} ${user.last_name} · <strong style="color:#e2e8f0">${user.role}</strong></span>
      <a href="/api/broker/logout">Sign out</a>
    </div>
  </div>

  <div class="main">
    ${billingBanner}

    <div class="welcome">
      <h2>Welcome back, ${user.first_name || user.email}</h2>
      <p>${isReadOnly ? 'Your workspace is in read-only mode. Subscribe to re-enable all features.' : 'Your broker workspace is active. Manage your team and settings below.'}</p>
    </div>

    <div class="grid" id="stats-grid">
      <div class="stat"><label>Workspace</label><div class="value" style="font-size:16px;margin-top:8px">${tenant.name}</div></div>
      <div class="stat"><label>Your Role</label><div class="value" style="font-size:16px;margin-top:8px;text-transform:capitalize">${user.role}</div></div>
      <div class="stat" id="team-count-stat"><label>Team Members</label><div class="value" id="team-count">—</div></div>
    </div>

    ${user.role === 'admin' && !isReadOnly ? `
    <div class="section">
      <div class="section-header"><h3>Team Members</h3></div>
      <div class="invite-form">
        <input type="email" id="invite-email" placeholder="colleague@yourfirm.com">
        <select id="invite-role"><option value="broker">Broker</option><option value="admin">Admin</option></select>
        <button class="btn btn-primary btn-sm" onclick="sendInvite()">Send Invite</button>
      </div>
      <div class="error-msg" id="invite-err"></div>
      <div class="invite-link" id="invite-link-box">
        Invite link: <span id="invite-link-text"></span>
        <span class="copy-btn" onclick="copyInvite()">[copy]</span>
      </div>
      <br>
      <table class="table" id="team-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last Login</th></tr></thead>
        <tbody id="team-tbody"><tr><td colspan="5" style="color:#64748b;text-align:center;padding:20px">Loading…</td></tr></tbody>
      </table>
    </div>
    ` : user.role === 'admin' && isReadOnly ? `
    <div class="section" style="opacity:0.5;pointer-events:none">
      <div class="section-header"><h3>Team Members <span style="font-size:12px;color:#64748b;font-weight:400">(read-only)</span></h3></div>
      <table class="table" id="team-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last Login</th></tr></thead>
        <tbody id="team-tbody"><tr><td colspan="5" style="color:#64748b;text-align:center;padding:20px">Loading…</td></tr></tbody>
      </table>
    </div>
    ` : ''}

    <div class="section">
      <div class="section-header"><h3>Account</h3></div>
      <table class="table">
        <tbody>
          <tr><td style="color:#64748b">Email</td><td>${user.email}</td></tr>
          <tr><td style="color:#64748b">Workspace</td><td>${tenant.name} <span style="color:#64748b;font-size:12px">(${tenant.slug})</span></td></tr>
          <tr><td style="color:#64748b">Role</td><td style="text-transform:capitalize">${user.role}</td></tr>
          <tr><td style="color:#64748b">Subscription</td><td><a href="/broker/billing" style="color:#60a5fa">${
            billingStatus === 'active' ? '✅ Active — €100/month' :
            billingStatus === 'trial' ? `⏳ Free trial (${daysLeft} days left)` :
            billingStatus === 'past_due' ? '🔴 Payment required' :
            billingStatus === 'cancelled' ? '🚫 Cancelled' : billingStatus
          }</a></td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    const IS_ADMIN = ${JSON.stringify(user.role === 'admin')};
    const IS_READONLY = ${JSON.stringify(isReadOnly)};

    async function loadTeam() {
      if (!IS_ADMIN) return;
      try {
        const r = await fetch('/api/broker/team');
        const d = await r.json();
        if (!d.success) return;
        document.getElementById('team-count').textContent = d.team.length;
        const tbody = document.getElementById('team-tbody');
        tbody.innerHTML = d.team.map(u => {
          const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || '—';
          const login = u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'Never';
          return '<tr>' +
            '<td>' + name + '</td>' +
            '<td>' + u.email + '</td>' +
            '<td><span class="pill pill-' + u.role + '">' + u.role + '</span></td>' +
            '<td><span class="pill pill-' + u.status + '">' + u.status + '</span></td>' +
            '<td>' + login + '</td>' +
            '</tr>';
        }).join('');
      } catch(e) { console.error(e); }
    }

    async function sendInvite() {
      if (IS_READONLY) return;
      const email = document.getElementById('invite-email').value.trim();
      const role = document.getElementById('invite-role').value;
      const err = document.getElementById('invite-err');
      err.style.display = 'none';
      if (!email) { err.textContent = 'Email is required'; err.style.display = 'block'; return; }
      try {
        const r = await fetch('/api/broker/invite', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ email, role })
        });
        const d = await r.json();
        if (d.success) {
          document.getElementById('invite-link-text').textContent = d.invite_url;
          document.getElementById('invite-link-box').style.display = 'block';
          document.getElementById('invite-email').value = '';
          loadTeam();
        } else {
          err.textContent = d.message; err.style.display = 'block';
        }
      } catch(e) { err.textContent = 'Network error'; err.style.display = 'block'; }
    }

    function copyInvite() {
      const text = document.getElementById('invite-link-text').textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = '[copied!]';
        setTimeout(() => btn.textContent = '[copy]', 2000);
      });
    }

    loadTeam();
  </script>
</body>
</html>`);
});

// GET /broker/signal-radar — Signal Radar dashboard (tenant-scoped)
app.get('/broker/signal-radar', (req, res) => {
  if (!req.session || !req.session.brokerUser) return res.redirect('/broker/login');
  const user = req.session.brokerUser;
  const tenant = req.session.brokerTenant;
  const billingStatus = effectiveBillingStatus(tenant);
  const daysLeft = trialDaysRemaining(tenant);
  const isReadOnly = billingStatus === 'past_due' || billingStatus === 'cancelled';

  let billingBanner = '';
  if (billingStatus === 'trial' && daysLeft <= 7) {
    billingBanner = `<div class="billing-banner warning">⏰ <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''} left</strong> on your free trial — <a href="/broker/billing">Subscribe now →</a></div>`;
  } else if (isReadOnly) {
    billingBanner = `<div class="billing-banner danger">🔒 <strong>Subscription required.</strong> Read-only mode. <a href="/broker/billing">Subscribe Now →</a></div>`;
  }

  const radarBrandColor = getBrandColor(tenant);
  const radarDisplayName = getDisplayName(tenant);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Signal Radar — ${radarDisplayName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  ${brandColorStyles(tenant)}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0f1e;
      --surface: #111827;
      --surface2: #1a2236;
      --border: #1e2d45;
      --border2: #263552;
      --text: #e8edf5;
      --text2: #8fa3bf;
      --text3: #4d6480;
      --gold: #c9a84c;
      --gold-dim: #8a6d2e;
      --hot: #ef4444;
      --hot-bg: #2d0a0a;
      --hot-border: #7f1d1d;
      --warm: #f59e0b;
      --warm-bg: #2d1a00;
      --warm-border: #78350f;
      --cold: #38bdf8;
      --cold-bg: #0c1e2e;
      --cold-border: #0e4d7a;
      --accent: #3b82f6;
      --accent-dim: #1e3a5f;
    }
    body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }

    /* ── TOPBAR ── */
    .topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 100; background: rgba(10,15,30,0.95); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); height: 54px; display: flex; align-items: center; padding: 0 28px; gap: 0; }
    .topbar-brand { font-size: 15px; font-weight: 700; color: var(--gold); letter-spacing: 0.5px; white-space: nowrap; margin-right: 32px; }
    .topbar-nav { display: flex; align-items: center; gap: 4px; flex: 1; }
    .topbar-nav a { color: var(--text2); text-decoration: none; font-size: 13px; font-weight: 500; padding: 6px 14px; border-radius: 6px; transition: all 0.15s; white-space: nowrap; }
    .topbar-nav a:hover { color: var(--text); background: var(--surface2); }
    .topbar-nav a.active { color: var(--text); background: var(--surface2); }
    .topbar-right { display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--text3); white-space: nowrap; }
    .topbar-right a { color: var(--text3); text-decoration: none; transition: color 0.15s; }
    .topbar-right a:hover { color: var(--text2); }

    /* ── BILLING BANNERS ── */
    .billing-banner { padding: 10px 28px; font-size: 13px; display: flex; align-items: center; gap: 8px; }
    .billing-banner.warning { background: #1c1400; border-bottom: 1px solid var(--warm-border); color: #fde68a; }
    .billing-banner.danger { background: #1a0000; border-bottom: 1px solid var(--hot-border); color: #fca5a5; }
    .billing-banner a { color: inherit; font-weight: 600; }

    /* ── MAIN LAYOUT ── */
    .page { padding-top: 54px; }
    .container { max-width: 1400px; margin: 0 auto; padding: 28px 28px 80px; }

    /* ── STATS ROW ── */
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; }
    .stat-card.hot { border-color: var(--hot-border); background: var(--hot-bg); }
    .stat-card.warm { border-color: var(--warm-border); background: var(--warm-bg); }
    .stat-card.cold { border-color: var(--cold-border); background: var(--cold-bg); }
    .stat-card.featured { border-color: var(--gold-dim); background: linear-gradient(135deg, #1a1200 0%, #0f0d00 100%); }
    .stat-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text3); margin-bottom: 6px; }
    .stat-value { font-size: 32px; font-weight: 700; line-height: 1; color: var(--text); }
    .stat-card.hot .stat-value { color: var(--hot); }
    .stat-card.warm .stat-value { color: var(--warm); }
    .stat-card.cold .stat-value { color: var(--cold); }
    .stat-card.featured .stat-value { color: var(--gold); font-size: 36px; }
    .stat-sub { font-size: 11px; color: var(--text3); margin-top: 4px; }

    /* ── SCANNER BAR ── */
    .scanner-bar { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
    .scanner-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text3); }
    .scanner-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text2); }
    .scanner-dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e; flex-shrink: 0; }
    .scanner-dot.idle { background: var(--text3); box-shadow: none; }
    .scanner-dot.error { background: var(--hot); box-shadow: 0 0 6px var(--hot); }
    /* ── SCAN CONFIG BAR ── */
    .scan-config-bar { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .scan-config-left { display: flex; align-items: center; gap: 14px; }
    .scan-config-right { display: flex; align-items: center; gap: 12px; }
    .scan-config-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text3); }
    .toggle-switch { position: relative; display: inline-flex; align-items: center; cursor: pointer; }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .toggle-track { display: inline-block; width: 38px; height: 20px; background: var(--border2); border-radius: 10px; transition: background 0.2s; position: relative; }
    .toggle-track::after { content: ''; position: absolute; left: 3px; top: 3px; width: 14px; height: 14px; background: #fff; border-radius: 50%; transition: transform 0.2s; }
    .toggle-switch input:checked + .toggle-track { background: #22c55e; }
    .toggle-switch input:checked + .toggle-track::after { transform: translateX(18px); }
    .scan-freq-select { background: var(--surface2); color: var(--text2); border: 1px solid var(--border2); border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer; outline: none; }
    .scan-freq-select:focus { border-color: var(--accent); }
    .btn-scan-now { background: linear-gradient(135deg, #1e40af, #3b82f6); color: #fff; border: none; border-radius: 6px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
    .btn-scan-now:hover { opacity: 0.85; }
    .btn-scan-now:disabled { opacity: 0.5; cursor: not-allowed; }
    .next-scan-info { font-size: 11px; color: var(--text3); }

    /* ── DEMO BANNER ── */
    .demo-banner { display: flex; align-items: center; gap: 12px; background: rgba(234,179,8,0.1); border: 1px solid rgba(234,179,8,0.35); border-radius: 8px; padding: 10px 16px; margin-bottom: 16px; font-size: 13px; }
    .demo-banner-icon { font-size: 16px; flex-shrink: 0; }
    .demo-banner-text { flex: 1; color: var(--text2); }
    .demo-banner-text strong { color: #eab308; }
    .btn-clear-demo { background: rgba(234,179,8,0.15); color: #eab308; border: 1px solid rgba(234,179,8,0.4); border-radius: 6px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; white-space: nowrap; flex-shrink: 0; }
    .btn-clear-demo:hover { background: rgba(234,179,8,0.25); border-color: #eab308; }
    .btn-clear-demo:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── TOOLBAR ── */
    .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .tab-group { display: flex; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .tab-btn { padding: 8px 18px; font-size: 13px; font-weight: 500; border: none; cursor: pointer; background: transparent; color: var(--text2); transition: all 0.15s; white-space: nowrap; }
    .tab-btn.active { background: var(--accent); color: #fff; }
    .tab-btn:hover:not(.active) { background: var(--surface2); color: var(--text); }
    .spacer { flex: 1; }
    .search-input { background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 8px 14px; font-size: 13px; color: var(--text); outline: none; width: 220px; transition: border-color 0.15s; }
    .search-input:focus { border-color: var(--accent); }
    .search-input::placeholder { color: var(--text3); }
    .btn { padding: 8px 16px; border: none; border-radius: 7px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: #2563eb; }
    .btn-gold { background: var(--gold); color: #0a0f1e; }
    .btn-gold:hover { background: #b8920e; }
    .btn-outline { background: transparent; border: 1px solid var(--border2); color: var(--text2); }
    .btn-outline:hover { border-color: var(--accent); color: var(--text); }
    .btn-sm { padding: 5px 12px; font-size: 12px; }
    .btn-danger { background: var(--hot-bg); border: 1px solid var(--hot-border); color: var(--hot); }
    .btn-danger:hover { background: #3d0000; }

    /* ── SIGNAL FEED ── */
    .feed-table { width: 100%; border-collapse: collapse; }
    .feed-table th { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text3); padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
    .feed-table td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .feed-table tr { cursor: pointer; transition: background 0.1s; }
    .feed-table tbody tr:hover td { background: var(--surface2); }
    .feed-table tr:last-child td { border-bottom: none; }
    .prospect-name { font-weight: 600; color: var(--text); }
    .prospect-company { font-size: 11px; color: var(--text3); margin-top: 2px; }
    .signal-type-cell { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; }
    .tier-pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .tier-pill.hot { background: var(--hot-bg); color: var(--hot); border: 1px solid var(--hot-border); }
    .tier-pill.warm { background: var(--warm-bg); color: var(--warm); border: 1px solid var(--warm-border); }
    .tier-pill.cold { background: var(--cold-bg); color: var(--cold); border: 1px solid var(--cold-border); }
    .score-badge { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 6px; font-size: 13px; font-weight: 700; }
    .score-high { background: var(--hot-bg); color: var(--hot); border: 1px solid var(--hot-border); }
    .score-mid { background: var(--warm-bg); color: var(--warm); border: 1px solid var(--warm-border); }
    .score-low { background: var(--surface2); color: var(--text2); border: 1px solid var(--border); }
    .excerpt-cell { font-size: 12px; color: var(--text3); max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .source-link { font-size: 11px; color: var(--accent); text-decoration: none; }
    .source-link:hover { text-decoration: underline; }
    .date-cell { font-size: 11px; color: var(--text3); white-space: nowrap; }
    .empty-state { text-align: center; padding: 60px 20px; color: var(--text3); }
    .empty-state .icon { font-size: 40px; margin-bottom: 12px; }
    .empty-state h3 { font-size: 16px; color: var(--text2); margin-bottom: 6px; }
    .empty-state p { font-size: 13px; }

    /* ── TIER VIEW ── */
    .tier-columns { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
    @media (max-width: 900px) { .tier-columns { grid-template-columns: 1fr; } }
    .tier-column { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .tier-column-header { padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); }
    .tier-column-header.hot { background: var(--hot-bg); border-bottom-color: var(--hot-border); }
    .tier-column-header.warm { background: var(--warm-bg); border-bottom-color: var(--warm-border); }
    .tier-column-header.cold { background: var(--cold-bg); border-bottom-color: var(--cold-border); }
    .tier-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
    .tier-title.hot { color: var(--hot); }
    .tier-title.warm { color: var(--warm); }
    .tier-title.cold { color: var(--cold); }
    .tier-count { font-size: 22px; font-weight: 700; color: var(--text); }
    .tier-body { padding: 8px; max-height: 600px; overflow-y: auto; }
    .prospect-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; cursor: pointer; transition: all 0.15s; }
    .prospect-card:hover { border-color: var(--accent); background: #151e35; }
    .prospect-card:last-child { margin-bottom: 0; }
    .pc-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 6px; }
    .pc-name { font-size: 13px; font-weight: 600; color: var(--text); }
    .pc-company { font-size: 11px; color: var(--text3); margin-top: 1px; }
    .pc-score { font-size: 18px; font-weight: 700; }
    .pc-score.hot { color: var(--hot); }
    .pc-score.warm { color: var(--warm); }
    .pc-score.cold { color: var(--text3); }
    .pc-signal { font-size: 11px; color: var(--text3); border-top: 1px solid var(--border); padding-top: 6px; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* ── SECTION WRAPPER ── */
    .section-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .section-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .section-title { font-size: 14px; font-weight: 600; color: var(--text); }
    .section-meta { font-size: 12px; color: var(--text3); }

    /* ── MODALS ── */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 500; display: flex; align-items: center; justify-content: center; padding: 20px; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
    .modal-overlay.open { opacity: 1; pointer-events: all; }
    .modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 14px; width: 100%; max-width: 560px; max-height: 90vh; overflow: hidden; display: flex; flex-direction: column; transform: translateY(20px); transition: transform 0.2s; }
    .modal-overlay.open .modal { transform: translateY(0); }
    .modal.modal-lg { max-width: 780px; }
    .modal-header { padding: 20px 24px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    .modal-title { font-size: 16px; font-weight: 700; color: var(--text); }
    .modal-close { background: none; border: none; color: var(--text3); font-size: 20px; cursor: pointer; padding: 2px 6px; border-radius: 4px; line-height: 1; transition: color 0.15s; }
    .modal-close:hover { color: var(--text); }
    .modal-body { padding: 20px 24px; overflow-y: auto; flex: 1; }
    .modal-footer { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; gap: 10px; justify-content: flex-end; flex-shrink: 0; }

    /* ── FORMS ── */
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field-full { grid-column: 1 / -1; }
    .field label { font-size: 12px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.4px; }
    .field input, .field textarea, .field select {
      background: var(--bg); border: 1px solid var(--border2); border-radius: 7px;
      padding: 9px 12px; font-size: 13px; color: var(--text); outline: none;
      transition: border-color 0.15s; font-family: inherit;
    }
    .field input:focus, .field textarea:focus { border-color: var(--accent); }
    .field input::placeholder, .field textarea::placeholder { color: var(--text3); }
    .field textarea { resize: vertical; min-height: 80px; }
    .error-msg { color: var(--hot); font-size: 12px; margin-top: 4px; display: none; }

    /* ── PROSPECT DETAIL ── */
    .detail-header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
    .detail-avatar { width: 52px; height: 52px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border2); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; }
    .detail-name { font-size: 20px; font-weight: 700; color: var(--text); }
    .detail-company { font-size: 13px; color: var(--text2); margin-top: 2px; }
    .detail-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .detail-tag { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text3); background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; }
    .detail-score { margin-left: auto; text-align: right; flex-shrink: 0; }
    .detail-score .score-num { font-size: 36px; font-weight: 800; line-height: 1; }
    .detail-score .score-label { font-size: 11px; color: var(--text3); }
    .detail-section { margin-bottom: 20px; }
    .detail-section h4 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text3); margin-bottom: 10px; }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .detail-field { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; }
    .detail-field .df-label { font-size: 10px; color: var(--text3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 2px; }
    .detail-field .df-value { font-size: 13px; color: var(--text); }

    /* ── SIGNAL TIMELINE ── */
    .timeline { position: relative; padding-left: 20px; }
    .timeline::before { content: ''; position: absolute; left: 6px; top: 0; bottom: 0; width: 2px; background: var(--border); }
    .tl-item { position: relative; margin-bottom: 16px; }
    .tl-item::before { content: ''; position: absolute; left: -17px; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--border2); border: 2px solid var(--border); }
    .tl-item.high::before { background: var(--hot); border-color: var(--hot); box-shadow: 0 0 6px var(--hot); }
    .tl-item.medium::before { background: var(--warm); border-color: var(--warm); }
    .tl-item.low::before { background: var(--cold); border-color: var(--cold); }
    .tl-date { font-size: 10px; color: var(--text3); margin-bottom: 3px; }
    .tl-title { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 3px; }
    .tl-summary { font-size: 12px; color: var(--text2); margin-bottom: 4px; line-height: 1.5; }
    .tl-source { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

    /* ── CSV UPLOAD ── */
    .drop-zone { border: 2px dashed var(--border2); border-radius: 10px; padding: 32px; text-align: center; cursor: pointer; transition: all 0.15s; }
    .drop-zone:hover, .drop-zone.drag-over { border-color: var(--accent); background: var(--accent-dim); }
    .drop-zone-icon { font-size: 36px; margin-bottom: 8px; }
    .drop-zone-text { font-size: 14px; color: var(--text2); }
    .drop-zone-sub { font-size: 12px; color: var(--text3); margin-top: 4px; }
    .preview-table-wrap { max-height: 200px; overflow-y: auto; margin-top: 16px; border: 1px solid var(--border); border-radius: 8px; }
    .preview-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .preview-table th { background: var(--surface2); padding: 6px 10px; text-align: left; font-weight: 600; color: var(--text2); border-bottom: 1px solid var(--border); white-space: nowrap; }
    .preview-table td { padding: 5px 10px; border-bottom: 1px solid var(--border); color: var(--text2); white-space: nowrap; }
    .preview-table tr:last-child td { border-bottom: none; }
    .import-summary { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-top: 12px; font-size: 13px; }
    .import-summary .ok { color: #22c55e; }
    .import-summary .skip { color: var(--warm); }
    .import-summary .err { color: var(--hot); }

    /* ── LOADING ── */
    .loading { text-align: center; padding: 40px; color: var(--text3); font-size: 13px; }
    .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid var(--border2); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 8px; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── RESPONSIVE ── */
    @media (max-width: 768px) {
      .container { padding: 16px 16px 60px; }
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .topbar { padding: 0 16px; }
      .feed-table th:nth-child(n+5), .feed-table td:nth-child(n+5) { display: none; }
      .form-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 480px) { .stats-row { grid-template-columns: 1fr 1fr; } }
    /* Globe */
    .globe-section { width: 100%; background: linear-gradient(180deg, #060d1f 0%, #091428 100%); border: 1px solid rgba(40,140,255,0.35); border-radius: 12px; margin-bottom: 20px; overflow: hidden; position: relative; height: 480px; box-shadow: 0 0 60px rgba(20,80,220,0.25), inset 0 0 100px rgba(0,20,80,0.6); }
    #globe-tier-controls button:hover { filter: brightness(1.35); }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js"></script>
</head>
<body>
<div class="page">

  <!-- TOPBAR -->
  <div class="topbar">
    ${topbarLogoHtml(tenant, 26)}
    <div class="topbar-nav">
      <a href="/broker/signal-radar" class="active">Signal Radar</a>
      <a href="/broker/matchmaker">🛥 Matchmaker</a>
      <a href="/broker/dashboard">Dashboard</a>
      ${user.role === 'admin' ? '<a href="/broker/settings/branding">⚙ Brand</a>' : ''}
      <a href="/broker/billing">Billing</a>
    </div>
    <div class="topbar-right">
      <span>${user.first_name || user.email}</span>
      <a href="/api/broker/logout">Sign out</a>
    </div>
  </div>

  ${billingBanner}

  <div class="container">

    <!-- GLOBE -->
    <div class="globe-section" id="globe-radar-section">
      <div style="position:absolute;top:18px;left:22px;z-index:10;pointer-events:none;">
        <div style="font-size:10px;letter-spacing:2.5px;color:rgba(255,60,60,0.9);text-transform:uppercase;font-weight:700;">🌐 Prospect Globe</div>
        <div style="font-size:9px;color:rgba(180,210,255,0.35);margin-top:3px;letter-spacing:1px;">LIVE SIGNAL RADAR</div>
      </div>
      <div id="globe-tier-controls" style="position:absolute;top:50%;right:18px;transform:translateY(-50%);z-index:10;display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:110px;">
        <button id="btn-tier-hot" style="cursor:pointer;background:rgba(255,40,40,0.18);border:1.5px solid rgba(255,50,50,0.6);color:#ff4444;padding:6px 14px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:1px;display:flex;align-items:center;justify-content:center;gap:6px;transition:all 0.2s;">
          <span class="tier-dot" style="width:7px;height:7px;border-radius:50%;background:#ff3333;box-shadow:0 0 6px #ff3333;flex-shrink:0;display:inline-block;"></span>
          HOT <span style="opacity:0.7;font-weight:400;">(0)</span>
        </button>
        <button id="btn-tier-warm" style="cursor:pointer;background:rgba(40,40,40,0.3);border:1.5px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.25);padding:6px 14px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:1px;display:flex;align-items:center;justify-content:center;gap:6px;transition:all 0.2s;">
          <span class="tier-dot" style="width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.15);flex-shrink:0;display:inline-block;"></span>
          WARM <span style="opacity:0.7;font-weight:400;">(0)</span>
        </button>
        <button id="btn-tier-cold" style="cursor:pointer;background:rgba(40,40,40,0.3);border:1.5px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.25);padding:6px 14px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:1px;display:flex;align-items:center;justify-content:center;gap:6px;transition:all 0.2s;">
          <span class="tier-dot" style="width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.15);flex-shrink:0;display:inline-block;"></span>
          COLD <span style="opacity:0.7;font-weight:400;">(0)</span>
        </button>
        <div style="height:1px;background:rgba(255,255,255,0.08);margin:2px 4px;"></div>
        <button id="btn-rotation" style="cursor:pointer;background:rgba(40,120,255,0.15);border:1.5px solid rgba(80,160,255,0.45);color:rgba(120,185,255,0.9);padding:6px 14px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:1px;display:flex;align-items:center;justify-content:center;gap:6px;transition:all 0.2s;">
          <span id="btn-rotation-icon">⏸</span>
          <span id="btn-rotation-label">STOP</span>
        </button>
      </div>
      <div style="position:absolute;bottom:16px;left:22px;z-index:10;pointer-events:none;font-size:9px;color:rgba(180,210,255,0.2);letter-spacing:1px;">DRAG TO ROTATE</div>
      <canvas id="globe-canvas" style="width:100%;height:100%;display:block;"></canvas>
      <div id="globe-tooltip" style="position:absolute;display:none;background:rgba(4,10,24,0.97);border-radius:8px;padding:12px 16px;pointer-events:none;z-index:20;min-width:180px;box-shadow:0 0 24px rgba(0,0,0,0.7);">
        <div id="tt-name" style="color:#fff;font-size:12px;font-weight:700;margin-bottom:3px;"></div>
        <div id="tt-company" style="color:rgba(255,255,255,0.45);font-size:10px;margin-bottom:6px;"></div>
        <div id="tt-location" style="font-size:10px;margin-bottom:6px;"></div>
        <div style="height:1px;background:rgba(255,255,255,0.08);margin-bottom:6px;"></div>
        <div id="tt-score" style="font-size:11px;font-weight:800;letter-spacing:0.5px;"></div>
      </div>
    </div>

    <!-- STATS -->
    <div class="stats-row">
      <div class="stat-card featured">
        <div class="stat-label">🔥 Hot Signals (7 days)</div>
        <div class="stat-value" id="stat-hot-signals">—</div>
        <div class="stat-sub" id="stat-all-signals-sub">loading…</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Prospects</div>
        <div class="stat-value" id="stat-total">—</div>
      </div>
      <div class="stat-card hot">
        <div class="stat-label">🔴 HOT</div>
        <div class="stat-value" id="stat-hot">—</div>
      </div>
      <div class="stat-card warm">
        <div class="stat-label">🟠 WARM</div>
        <div class="stat-value" id="stat-warm">—</div>
      </div>
      <div class="stat-card cold">
        <div class="stat-label">🔵 COLD</div>
        <div class="stat-value" id="stat-cold">—</div>
      </div>
    </div>

    <!-- SCANNER STATUS -->
    <div class="scanner-bar">
      <div class="scanner-label">Scanner</div>
      <div class="scanner-item">
        <div class="scanner-dot idle" id="scanner-dot"></div>
        <span id="scanner-status-text">Loading…</span>
      </div>
      <div class="scanner-item" id="scanner-sources-item" style="display:none">
        📡 <span id="scanner-sources-text"></span>
      </div>
      <div class="scanner-item" id="scanner-last-item" style="display:none">
        🕒 Last scan: <span id="scanner-last-text"></span>
      </div>
      <div class="scanner-item" id="scanner-err-item" style="display:none; color: var(--hot)">
        ⚠️ <span id="scanner-err-text"></span>
      </div>
    </div>

    ${isReadOnly ? '' : `
    <!-- AUTO-SCAN CONFIG BAR -->
    <div class="scan-config-bar" id="scanConfigBar">
      <div class="scan-config-left">
        <span class="scan-config-label">⏰ Auto-Scan</span>
        <label class="toggle-switch" title="Enable/disable automated daily scanning">
          <input type="checkbox" id="scanEnabled" onchange="updateScanConfig()">
          <span class="toggle-track"></span>
        </label>
        <select class="scan-freq-select" id="scanFrequency" onchange="updateScanConfig()" title="Scan frequency">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        <span class="next-scan-info" id="nextScanText"></span>
      </div>
      <div class="scan-config-right">
        <button class="btn-scan-now" id="btnScanNow" onclick="triggerDailyScan()">▶ Run Now</button>
      </div>
    </div>
    `}

    <!-- DEMO DATA BANNER (shown only when is_demo prospects exist) -->
    <div class="demo-banner" id="demoBanner" style="display:none">
      <div class="demo-banner-icon">⚠️</div>
      <div class="demo-banner-text">
        <strong id="demoBannerCount">23 demo prospects</strong> are loaded as sample data.
        Import your real prospect list via CSV or add them manually, then remove the placeholders.
      </div>
      <button class="btn-clear-demo" id="btnClearDemo" onclick="clearDemoProspects()">🗑 Clear Demo Data</button>
    </div>

    <!-- TOOLBAR -->
    <div class="toolbar">
      <div class="tab-group">
        <button class="tab-btn active" id="tab-feed" onclick="switchTab('feed')">📊 Signal Feed</button>
        <button class="tab-btn" id="tab-tier" onclick="switchTab('tier')">📋 Tier View</button>
      </div>
      <input type="text" class="search-input" id="search-input" placeholder="Search prospects…" oninput="handleSearch(this.value)">
      <div class="spacer"></div>
      ${isReadOnly ? '' : `
      <button class="btn btn-outline" onclick="openCsvModal()">📤 CSV Upload</button>
      <button class="btn btn-gold" onclick="openAddModal()">＋ Add Prospect</button>
      `}
    </div>

    <!-- SIGNAL FEED -->
    <div id="view-feed">
      <div class="section-wrap">
        <div class="section-header">
          <div class="section-title">Recent Signals</div>
          <div class="section-meta" id="feed-meta">Loading…</div>
        </div>
        <div id="feed-loading" class="loading"><div class="spinner"></div><br>Loading signals…</div>
        <div id="feed-content" style="display:none">
          <table class="feed-table">
            <thead><tr>
              <th>#</th><th>Prospect</th><th>Signal</th><th>Source</th><th>Date</th><th>Score</th><th>Excerpt</th>
            </tr></thead>
            <tbody id="feed-tbody"></tbody>
          </table>
          <div id="feed-empty" class="empty-state" style="display:none">
            <div class="icon">📡</div>
            <h3>No signals detected yet</h3>
            <p>Signals will appear here as the scanner processes your prospect list.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- TIER VIEW -->
    <div id="view-tier" style="display:none">
      <div class="tier-columns">
        <div class="tier-column">
          <div class="tier-column-header hot">
            <span class="tier-title hot">🔴 HOT</span>
            <span class="tier-count" id="tier-hot-cnt">—</span>
          </div>
          <div class="tier-body" id="tier-hot-body"><div class="loading"><div class="spinner"></div></div></div>
        </div>
        <div class="tier-column">
          <div class="tier-column-header warm">
            <span class="tier-title warm">🟠 WARM</span>
            <span class="tier-count" id="tier-warm-cnt">—</span>
          </div>
          <div class="tier-body" id="tier-warm-body"><div class="loading"><div class="spinner"></div></div></div>
        </div>
        <div class="tier-column">
          <div class="tier-column-header cold">
            <span class="tier-title cold">🔵 COLD</span>
            <span class="tier-count" id="tier-cold-cnt">—</span>
          </div>
          <div class="tier-body" id="tier-cold-body"><div class="loading"><div class="spinner"></div></div></div>
        </div>
      </div>
    </div>

  </div><!-- /container -->
</div><!-- /page -->

<!-- ADD PROSPECT MODAL -->
<div class="modal-overlay" id="add-modal">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title">Add Prospect</div>
      <button class="modal-close" onclick="closeAddModal()">×</button>
    </div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="field field-full">
          <label>Name <span style="color:var(--hot)">*</span></label>
          <input type="text" id="add-name" placeholder="e.g. Jeff Bezos">
        </div>
        <div class="field"><label>Company</label><input type="text" id="add-company" placeholder="e.g. Amazon"></div>
        <div class="field"><label>Email</label><input type="email" id="add-email" placeholder="email@example.com"></div>
        <div class="field"><label>Phone</label><input type="text" id="add-phone" placeholder="+1 555 000 0000"></div>
        <div class="field"><label>Location</label><input type="text" id="add-location" placeholder="Monaco, France"></div>
        <div class="field"><label>Yacht Interest</label><input type="text" id="add-yacht" placeholder="e.g. 80m+ superyacht"></div>
        <div class="field field-full">
          <label>Social Handles <span style="font-size:10px;color:var(--text3);font-weight:400">(JSON format)</span></label>
          <input type="text" id="add-social" placeholder='{"twitter":"@handle","instagram":"@handle"}'>
        </div>
        <div class="field field-full">
          <label>Notes</label>
          <textarea id="add-notes" placeholder="Additional context about this prospect…"></textarea>
        </div>
      </div>
      <div class="error-msg" id="add-error"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeAddModal()">Cancel</button>
      <button class="btn btn-gold" id="add-submit-btn" onclick="submitAddProspect()">Add Prospect</button>
    </div>
  </div>
</div>

<!-- CSV UPLOAD MODAL -->
<div class="modal-overlay" id="csv-modal">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title">CSV Bulk Import</div>
      <button class="modal-close" onclick="closeCsvModal()">×</button>
    </div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px">
        Required column: <code style="color:var(--gold);background:var(--surface2);padding:1px 6px;border-radius:3px">name</code>.
        Optional: <code style="color:var(--text3)">company, email, phone, location, yacht_interest, notes, tier</code>
      </p>
      <div class="drop-zone" id="drop-zone" onclick="document.getElementById('csv-file-input').click()">
        <input type="file" id="csv-file-input" accept=".csv,.txt" style="display:none" onchange="handleCsvFile(this.files[0])">
        <div class="drop-zone-icon">📄</div>
        <div class="drop-zone-text">Click to select CSV file</div>
        <div class="drop-zone-sub">or drag and drop here</div>
      </div>
      <div id="csv-preview" style="display:none">
        <div class="preview-table-wrap">
          <table class="preview-table"><thead id="preview-thead"></thead><tbody id="preview-tbody"></tbody></table>
        </div>
        <p style="font-size:12px;color:var(--text3);margin-top:8px" id="csv-row-count"></p>
      </div>
      <div class="import-summary" id="import-summary" style="display:none"></div>
      <div class="error-msg" id="csv-error"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeCsvModal()">Close</button>
      <button class="btn btn-gold" id="csv-import-btn" style="display:none" onclick="importCsv()">Import Prospects</button>
    </div>
  </div>
</div>

<!-- PROSPECT DETAIL MODAL -->
<div class="modal-overlay" id="detail-modal">
  <div class="modal modal-lg">
    <div class="modal-header">
      <div class="modal-title" id="detail-modal-title">Prospect Details</div>
      <button class="modal-close" onclick="closeDetailModal()">×</button>
    </div>
    <div class="modal-body" id="detail-modal-body">
      <div class="loading"><div class="spinner"></div></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline btn-sm" onclick="closeDetailModal()">Close</button>
      <button class="btn btn-primary btn-sm" id="detail-scan-btn" onclick="scanCurrentProspect()" style="display:none">🔍 Scan Now</button>
      ${user.role === 'admin' && !isReadOnly ? `<button class="btn btn-danger btn-sm" id="detail-delete-btn" onclick="deleteCurrentProspect()" style="display:none">Delete</button>` : ''}
    </div>
  </div>
</div>

<script>
  const IS_READONLY = ${JSON.stringify(isReadOnly)};
  const IS_ADMIN = ${JSON.stringify(user.role === 'admin')};
  let allSignals = [], allProspects = [], currentPid = null, csvRows = [];

  const SIGNAL_ICONS = {
    'Company Exit / Sale':'💰','IPO Event':'📈','Major Funding Round':'💵','Liquidation Event':'💰',
    'CEO/Chairman Promotion':'👑','Board Appointment':'🏛️','Senior Role Change':'🔄',
    'Major Award/Recognition':'🏆','Yacht Brand Mention':'⛵','Boat Show Attendance':'🎪',
    'Luxury Lifestyle Signal':'💎','Yacht Account Follow':'📡'
  };

  function sigIcon(tn, st) { return SIGNAL_ICONS[tn] || SIGNAL_ICONS[st] || '📰'; }
  function scClass(s) { return s >= 8 ? 'score-high' : s >= 5 ? 'score-mid' : 'score-low'; }
  function timeAgo(ds) {
    if (!ds) return '—';
    const d = new Date(ds), diff = Date.now() - d.getTime();
    const m = Math.floor(diff/60000), h = Math.floor(m/60), dy = Math.floor(h/24);
    if (dy > 30) return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
    if (dy > 0) return dy+'d ago'; if (h > 0) return h+'h ago'; if (m > 0) return m+'m ago'; return 'Just now';
  }
  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── DATA ──────────────────────────────────────────────────────────────────────
  async function loadStats() {
    try {
      const d = await fetch('/api/broker/radar/stats').then(r=>r.json());
      if (!d.success) return;
      document.getElementById('stat-hot-signals').textContent = d.hot_signals_7d;
      document.getElementById('stat-all-signals-sub').textContent = d.all_signals_7d + ' total signals this week';
      document.getElementById('stat-total').textContent = d.total_prospects;
      document.getElementById('stat-hot').textContent = d.hot_prospects;
      document.getElementById('stat-warm').textContent = d.warm_prospects;
      document.getElementById('stat-cold').textContent = d.cold_prospects;
    } catch(e) {}
  }

  async function loadScannerStatus() {
    try {
      const d = await fetch('/api/broker/radar/scanner/status').then(r=>r.json());
      if (!d.success) return;
      const dot = document.getElementById('scanner-dot');
      if (d.recent_scans && d.recent_scans.length > 0) {
        const last = d.recent_scans[0];
        dot.className = 'scanner-dot' + (last.status === 'error' ? ' error' : '');
        document.getElementById('scanner-status-text').textContent = d.scanned_prospects + ' / ' + d.total_prospects + ' prospects scanned';
        document.getElementById('scanner-last-item').style.display = '';
        document.getElementById('scanner-last-text').textContent = timeAgo(last.started_at);
      } else {
        dot.className = 'scanner-dot idle';
        document.getElementById('scanner-status-text').textContent = 'Not yet scanned';
      }
      if (d.sources_active && d.sources_active.length) {
        document.getElementById('scanner-sources-item').style.display = '';
        document.getElementById('scanner-sources-text').textContent = d.sources_active.join(', ');
      }
      if (d.errors_24h > 0) {
        document.getElementById('scanner-err-item').style.display = '';
        document.getElementById('scanner-err-text').textContent = d.errors_24h + ' error(s) last 24h';
      }
      // Populate scan config panel
      if (d.scan_config) {
        const cfg = d.scan_config;
        const enabledEl = document.getElementById('scanEnabled');
        const freqEl = document.getElementById('scanFrequency');
        const nextEl = document.getElementById('nextScanText');
        if (enabledEl) enabledEl.checked = cfg.scan_enabled !== false;
        if (freqEl) freqEl.value = cfg.scan_frequency || 'daily';
        if (nextEl) {
          if (cfg.next_scheduled_scan && cfg.scan_enabled) {
            const isDateStr = cfg.next_scheduled_scan.match(/^\d{4}-/);
            if (isDateStr) {
              const nextDate = new Date(cfg.next_scheduled_scan);
              const now = new Date();
              const diffMs = nextDate - now;
              if (diffMs > 0) {
                const diffH = Math.round(diffMs / 3600000);
                nextEl.textContent = diffH < 2 ? 'Next scan in < 2h' : 'Next in ~' + diffH + 'h';
              } else {
                nextEl.textContent = 'Scan due — will run next hour';
              }
            } else {
              nextEl.textContent = cfg.next_scheduled_scan;
            }
          } else if (!cfg.scan_enabled) {
            nextEl.textContent = 'Auto-scan disabled';
          } else {
            nextEl.textContent = 'Pending first run';
          }
        }
      }
    } catch(e) {}
  }

  async function updateScanConfig() {
    const enabled = document.getElementById('scanEnabled')?.checked;
    const freq = document.getElementById('scanFrequency')?.value || 'daily';
    try {
      await fetch('/api/broker/radar/scan/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scan_enabled: enabled, scan_frequency: freq })
      });
      // Refresh status after save
      setTimeout(loadScannerStatus, 300);
    } catch(e) { console.error('Failed to save scan config', e); }
  }

  async function triggerDailyScan() {
    const btn = document.getElementById('btnScanNow');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '⏳ Scanning…';
    try {
      const d = await fetch('/api/broker/radar/scan/trigger-daily', { method: 'POST' }).then(r=>r.json());
      if (d.success) {
        btn.textContent = '✓ Scan started';
        btn.style.background = 'linear-gradient(135deg,#065f46,#059669)';
        setTimeout(() => {
          btn.textContent = '▶ Run Now';
          btn.style.background = '';
          btn.disabled = false;
          loadScannerStatus();
        }, 4000);
      } else {
        btn.textContent = '✗ Failed';
        setTimeout(() => { btn.textContent = '▶ Run Now'; btn.disabled = false; }, 3000);
      }
    } catch(e) {
      btn.textContent = '▶ Run Now';
      btn.disabled = false;
    }
  }

  async function loadSignalFeed(search) {
    document.getElementById('feed-loading').style.display = 'block';
    document.getElementById('feed-content').style.display = 'none';
    try {
      const d = await fetch('/api/broker/radar/signals/feed?days=60&limit=100').then(r=>r.json());
      if (!d.success) { document.getElementById('feed-loading').innerHTML = '<p style="color:var(--hot)">Failed to load signals</p>'; return; }
      allSignals = d.signals || [];
      renderFeed(search || '');
    } catch(e) { document.getElementById('feed-loading').innerHTML = '<p style="color:var(--hot)">Network error</p>'; }
  }

  function renderFeed(search) {
    document.getElementById('feed-loading').style.display = 'none';
    document.getElementById('feed-content').style.display = 'block';
    const q = search.toLowerCase();
    const filtered = !q ? allSignals : allSignals.filter(s =>
      (s.prospect_name||'').toLowerCase().includes(q) ||
      (s.prospect_company||'').toLowerCase().includes(q) ||
      (s.title||'').toLowerCase().includes(q) ||
      (s.trigger_name||'').toLowerCase().includes(q)
    );
    document.getElementById('feed-meta').textContent = filtered.length + ' signal' + (filtered.length!==1?'s':'') + ' (last 60 days)';
    const empty = document.getElementById('feed-empty');
    const tbody = document.getElementById('feed-tbody');
    if (!filtered.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
    empty.style.display = 'none';
    tbody.innerHTML = filtered.map((s,i) => {
      const tier = (s.heat_tier||'cold').toLowerCase();
      return '<tr onclick="openDetail(' + s.prospect_id + ')">' +
        '<td style="color:var(--text3);font-size:12px">' + (i+1) + '</td>' +
        '<td><div class="prospect-name">' + esc(s.prospect_name) + '</div>' +
          '<div class="prospect-company">' + esc(s.prospect_company||'') + '</div>' +
          '<div style="margin-top:3px"><span class="tier-pill ' + tier + '">' + tier.toUpperCase() + '</span></div></td>' +
        '<td><span class="signal-type-cell">' + sigIcon(s.trigger_name,s.signal_type) + ' ' + esc(s.trigger_name||s.signal_type) + '</span></td>' +
        '<td>' + (s.source_url ?
          '<a class="source-link" href="' + esc(s.source_url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(s.source_name||'Link') + '</a>' :
          '<span style="color:var(--text3)">' + esc(s.source_name||'—') + '</span>') + '</td>' +
        '<td class="date-cell">' + timeAgo(s.detected_at) + '</td>' +
        '<td><span class="score-badge ' + scClass(s.score) + '">' + (s.score||0) + '</span></td>' +
        '<td class="excerpt-cell">' + esc(s.summary||s.title||'') + '</td>' +
        '</tr>';
    }).join('');
  }

  async function loadProspects(search) {
    try {
      const params = search ? '?search=' + encodeURIComponent(search) : '';
      const d = await fetch('/api/broker/radar/prospects' + params).then(r=>r.json());
      if (!d.success) return;
      allProspects = d.prospects || [];
      updateDemoBanner(d.demo_count || 0);
      renderTierView(search||'');
    } catch(e) {}
  }

  function updateDemoBanner(demoCount) {
    const banner = document.getElementById('demoBanner');
    if (!banner) return;
    if (demoCount > 0) {
      document.getElementById('demoBannerCount').textContent =
        demoCount + ' demo prospect' + (demoCount !== 1 ? 's' : '');
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  async function clearDemoProspects() {
    const btn = document.getElementById('btnClearDemo');
    const countText = document.getElementById('demoBannerCount').textContent;
    if (!confirm('Remove ' + countText + '? This cannot be undone.\\n\\nOnly demo placeholder prospects will be deleted — any real prospects you have added are safe.')) return;
    btn.disabled = true;
    btn.textContent = 'Clearing…';
    try {
      const d = await fetch('/api/broker/radar/prospects/clear-demo', { method: 'DELETE' }).then(r=>r.json());
      if (d.success) {
        document.getElementById('demoBanner').style.display = 'none';
        await Promise.all([loadStats(), loadSignalFeed(''), loadProspects('')]);
        // Brief success flash
        const flash = document.createElement('div');
        flash.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#16a34a;color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.3)';
        flash.textContent = '✓ ' + d.message;
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 3500);
      } else {
        alert('Failed to clear demo prospects: ' + (d.message || 'Unknown error'));
        btn.disabled = false;
        btn.textContent = '🗑 Clear Demo Data';
      }
    } catch(e) {
      alert('Request failed. Please try again.');
      btn.disabled = false;
      btn.textContent = '🗑 Clear Demo Data';
    }
  }

  function renderTierView(search) {
    const q = search.toLowerCase();
    const filtered = !q ? allProspects : allProspects.filter(p =>
      (p.name||'').toLowerCase().includes(q) ||
      (p.company||'').toLowerCase().includes(q) ||
      (p.location||'').toLowerCase().includes(q)
    );
    const hot=[], warm=[], cold=[];
    for (const p of filtered) {
      const t = (p.heat_tier||'cold').toLowerCase();
      if (t==='hot') hot.push(p); else if (t==='warm') warm.push(p); else cold.push(p);
    }
    document.getElementById('tier-hot-cnt').textContent = hot.length;
    document.getElementById('tier-warm-cnt').textContent = warm.length;
    document.getElementById('tier-cold-cnt').textContent = cold.length;
    renderTierCol('tier-hot-body', hot, 'hot');
    renderTierCol('tier-warm-body', warm, 'warm');
    renderTierCol('tier-cold-body', cold, 'cold');
  }

  function renderTierCol(bodyId, prospects, tier) {
    const el = document.getElementById(bodyId);
    if (!prospects.length) { el.innerHTML = '<div class="empty-state" style="padding:24px"><p>No ' + tier + ' prospects</p></div>'; return; }
    el.innerHTML = prospects.map(p =>
      '<div class="prospect-card" onclick="openDetail(' + p.id + ')">' +
        '<div class="pc-header"><div>' +
          '<div class="pc-name">' + esc(p.name) + '</div>' +
          '<div class="pc-company">' + esc(p.company||p.location||'—') + '</div>' +
        '</div><div class="pc-score ' + tier + '">' + (p.heat_score||0) + '</div></div>' +
        '<div class="pc-signal">📡 ' + esc(p.latest_signal_title||'No signals yet') + '</div>' +
        (parseInt(p.signal_count) > 0 ? '<div style="margin-top:4px;font-size:11px;color:var(--text3)">⚡ ' + p.signal_count + ' signal' + (p.signal_count!=1?'s':'') + '</div>' : '') +
      '</div>'
    ).join('');
  }

  // ── TABS ──────────────────────────────────────────────────────────────────────
  function switchTab(tab) {
    document.getElementById('view-feed').style.display = tab==='feed' ? '' : 'none';
    document.getElementById('view-tier').style.display = tab==='tier' ? '' : 'none';
    document.getElementById('tab-feed').classList.toggle('active', tab==='feed');
    document.getElementById('tab-tier').classList.toggle('active', tab==='tier');
    if (tab==='tier' && !allProspects.length) loadProspects('');
  }

  let searchTimer;
  function handleSearch(val) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const view = document.getElementById('view-feed').style.display !== 'none' ? 'feed' : 'tier';
      if (view==='feed') renderFeed(val); else renderTierView(val);
    }, 200);
  }

  // ── ADD PROSPECT ──────────────────────────────────────────────────────────────
  function openAddModal() {
    if (IS_READONLY) return;
    ['add-name','add-company','add-email','add-phone','add-location','add-yacht','add-social','add-notes'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('add-error').style.display = 'none';
    document.getElementById('add-submit-btn').disabled = false;
    document.getElementById('add-submit-btn').textContent = 'Add Prospect';
    document.getElementById('add-modal').classList.add('open');
    setTimeout(() => document.getElementById('add-name').focus(), 50);
  }
  function closeAddModal() { document.getElementById('add-modal').classList.remove('open'); }

  async function submitAddProspect() {
    if (IS_READONLY) return;
    const name = document.getElementById('add-name').value.trim();
    if (!name) { const e = document.getElementById('add-error'); e.textContent='Name is required'; e.style.display='block'; return; }
    const btn = document.getElementById('add-submit-btn');
    btn.disabled = true; btn.textContent = 'Adding…';
    const errEl = document.getElementById('add-error'); errEl.style.display = 'none';
    let social = {};
    const sv = document.getElementById('add-social').value.trim();
    if (sv) { try { social = JSON.parse(sv); } catch(_) { social = {raw:sv}; } }
    try {
      const r = await fetch('/api/broker/radar/prospects', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          name, email: document.getElementById('add-email').value.trim()||null,
          phone: document.getElementById('add-phone').value.trim()||null,
          company: document.getElementById('add-company').value.trim()||null,
          location: document.getElementById('add-location').value.trim()||null,
          current_yacht_interest: document.getElementById('add-yacht').value.trim()||null,
          social_handles: social,
          notes: document.getElementById('add-notes').value.trim()||null
        })
      });
      const d = await r.json();
      if (d.success) {
        closeAddModal();
        await Promise.all([loadStats(), loadSignalFeed(''), loadProspects('')]);
      } else {
        errEl.textContent = d.message||'Failed'; errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Add Prospect';
      }
    } catch(e) {
      errEl.textContent = 'Network error'; errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Add Prospect';
    }
  }

  // ── PROSPECT DETAIL ───────────────────────────────────────────────────────────
  async function openDetail(pid) {
    currentPid = pid;
    document.getElementById('detail-modal-title').textContent = 'Loading…';
    document.getElementById('detail-modal-body').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    document.getElementById('detail-scan-btn').style.display = 'none';
    const db = document.getElementById('detail-delete-btn'); if(db) db.style.display='none';
    document.getElementById('detail-modal').classList.add('open');
    try {
      const d = await fetch('/api/broker/radar/prospects/' + pid).then(r=>r.json());
      if (!d.success) { document.getElementById('detail-modal-body').innerHTML='<p style="color:var(--hot)">Failed to load</p>'; return; }
      renderDetail(d.prospect, d.signals, d.scan_history);
    } catch(e) { document.getElementById('detail-modal-body').innerHTML='<p style="color:var(--hot)">Network error</p>'; }
  }

  function renderDetail(p, signals, scans) {
    const tier = (p.heat_tier||'cold').toLowerCase();
    document.getElementById('detail-modal-title').textContent = p.name;
    const scoreColor = tier==='hot'?'var(--hot)':tier==='warm'?'var(--warm)':'var(--cold)';
    const social = p.social_handles||{};
    const socialHtml = Object.entries(social).map(([k,v])=>'<span class="detail-tag">📱 '+esc(k)+': '+esc(v)+'</span>').join('');
    const fieldDefs = [
      ['Company',p.company],['Location',p.location],['Email',p.email],['Phone',p.phone],
      ['Yacht Interest',p.current_yacht_interest],['Commercial Contact',p.commercial_contact],
      ['Date Added',p.date_added?new Date(p.date_added).toLocaleDateString('en-GB'):null],
      ['Last Scanned',p.last_scanned_at?timeAgo(p.last_scanned_at):'Never']
    ].filter(f=>f[1]);

    let html = '<div class="detail-header"><div class="detail-avatar">👤</div><div style="flex:1">';
    html += '<div class="detail-name">'+esc(p.name)+'</div>';
    if(p.company) html += '<div class="detail-company">'+esc(p.company)+'</div>';
    html += '<div class="detail-meta"><span class="tier-pill '+tier+'">'+tier.toUpperCase()+'</span>';
    if(signals.length) html += '<span class="detail-tag">⚡ '+signals.length+' signal'+(signals.length!==1?'s':'')+'</span>';
    html += socialHtml + '</div></div>';
    html += '<div class="detail-score"><div class="score-num" style="color:'+scoreColor+'">'+(p.heat_score||0)+'</div><div class="score-label">Score</div></div>';
    html += '</div>';

    if (fieldDefs.length) {
      html += '<div class="detail-section"><h4>Profile</h4><div class="detail-grid">';
      fieldDefs.forEach(([lbl,val]) => { html += '<div class="detail-field"><div class="df-label">'+esc(lbl)+'</div><div class="df-value">'+esc(val)+'</div></div>'; });
      html += '</div></div>';
    }
    if (p.notes) html += '<div class="detail-section"><h4>Notes</h4><div class="detail-field"><div class="df-value">'+esc(p.notes)+'</div></div></div>';

    html += '<div class="detail-section"><h4>Signal Timeline ('+signals.length+')</h4>';
    if (!signals.length) {
      html += '<div style="color:var(--text3);font-size:13px;padding:12px 0">No signals detected yet. Click "Scan Now" to run a search.</div>';
    } else {
      html += '<div class="timeline">';
      signals.forEach(s => {
        const cat = s.trigger_category||'low';
        html += '<div class="tl-item '+cat+'">';
        html += '<div class="tl-date">'+timeAgo(s.detected_at)+(s.source_name?' · '+esc(s.source_name):'')+'</div>';
        html += '<div class="tl-title">'+sigIcon(s.trigger_name,s.signal_type)+' '+esc(s.title||s.trigger_name||s.signal_type)+'</div>';
        if(s.summary) html += '<div class="tl-summary">'+esc(s.summary)+'</div>';
        html += '<div class="tl-source"><span class="score-badge '+scClass(s.score)+'" style="width:24px;height:24px;font-size:11px">'+(s.score||0)+'</span>';
        if(s.source_url) html += '<a class="source-link" href="'+esc(s.source_url)+'" target="_blank" rel="noopener">View Source →</a>';
        html += '</div></div>';
      });
      html += '</div>';
    }
    html += '</div>';

    document.getElementById('detail-modal-body').innerHTML = html;
    if (!IS_READONLY) document.getElementById('detail-scan-btn').style.display = '';
    const db = document.getElementById('detail-delete-btn'); if(db) db.style.display='';
  }

  function closeDetailModal() { document.getElementById('detail-modal').classList.remove('open'); currentPid=null; }

  async function scanCurrentProspect() {
    if (!currentPid||IS_READONLY) return;
    const btn = document.getElementById('detail-scan-btn');
    btn.disabled=true; btn.textContent='⏳ Scanning…';
    try {
      const d = await fetch('/api/broker/radar/scanner/scan/'+currentPid,{method:'POST'}).then(r=>r.json());
      if(d.success) {
        btn.textContent='✅ Done (' + (d.signals_found||0) + ' new)';
        setTimeout(async()=>{ btn.disabled=false; btn.textContent='🔍 Scan Now';
          await openDetail(currentPid);
          await Promise.all([loadStats(), loadSignalFeed(''), loadScannerStatus()]);
        }, 2000);
      } else {
        btn.textContent='❌ '+(d.message||'Failed');
        setTimeout(()=>{ btn.disabled=false; btn.textContent='🔍 Scan Now'; }, 3000);
      }
    } catch(e) { btn.textContent='❌ Error'; setTimeout(()=>{ btn.disabled=false; btn.textContent='🔍 Scan Now'; },3000); }
  }

  async function deleteCurrentProspect() {
    if (!currentPid||IS_READONLY||!IS_ADMIN) return;
    const nm = document.getElementById('detail-modal-title').textContent;
    if (!confirm('Delete '+nm+'? This cannot be undone.')) return;
    try {
      const d = await fetch('/api/broker/radar/prospects/'+currentPid,{method:'DELETE'}).then(r=>r.json());
      if(d.success) { closeDetailModal(); await Promise.all([loadStats(),loadSignalFeed(''),loadProspects('')]); }
    } catch(e) { alert('Delete failed'); }
  }

  // ── CSV ───────────────────────────────────────────────────────────────────────
  function openCsvModal() {
    if (IS_READONLY) return;
    document.getElementById('csv-preview').style.display='none';
    document.getElementById('import-summary').style.display='none';
    document.getElementById('csv-error').style.display='none';
    document.getElementById('csv-import-btn').style.display='none';
    document.getElementById('csv-file-input').value='';
    csvRows=[];
    document.getElementById('csv-modal').classList.add('open');
  }
  function closeCsvModal() { document.getElementById('csv-modal').classList.remove('open'); csvRows=[]; }

  function handleCsvFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        csvRows = parseCsv(e.target.result);
        showCsvPreview(csvRows);
      } catch(err) {
        const el=document.getElementById('csv-error'); el.textContent='Parse error: '+err.message; el.style.display='block';
      }
    };
    reader.readAsText(file);
  }

  function parseCsv(txt) {
    const lines = txt.trim().split(/\\r?\\n/);
    if (lines.length < 2) throw new Error('Need at least header + 1 row');
    const headers = lines[0].split(',').map(h=>h.trim().replace(/^["\\'']|["\\'']$/g,'').toLowerCase());
    if (!headers.includes('name')) throw new Error('CSV must have a "name" column');
    return lines.slice(1).filter(l=>l.trim()).map(l => {
      const vals = splitCsv(l);
      const row = {}; headers.forEach((h,j) => row[h]=(vals[j]||'').trim().replace(/^["\\'']|["\\'']$/g,''));
      return row;
    }).filter(r=>r.name);
  }

  function splitCsv(line) {
    const res=[]; let cur='',inQ=false;
    for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){inQ=!inQ;}else if(c===','&&!inQ){res.push(cur);cur='';}else{cur+=c;}}
    res.push(cur); return res;
  }

  function showCsvPreview(data) {
    if (!data.length) { const e=document.getElementById('csv-error'); e.textContent='No valid rows found'; e.style.display='block'; return; }
    const keys=Object.keys(data[0]);
    document.getElementById('preview-thead').innerHTML='<tr>'+keys.map(k=>'<th>'+esc(k)+'</th>').join('')+'</tr>';
    document.getElementById('preview-tbody').innerHTML=data.slice(0,5).map(r=>'<tr>'+keys.map(k=>'<td>'+esc(r[k]||'')+'</td>').join('')+'</tr>').join('');
    document.getElementById('csv-row-count').textContent=data.length+' prospects ready to import'+(data.length>5?' (showing first 5)':'');
    document.getElementById('csv-preview').style.display='block';
    document.getElementById('csv-import-btn').style.display='inline-flex';
    document.getElementById('import-summary').style.display='none';
    document.getElementById('csv-error').style.display='none';
  }

  async function importCsv() {
    if (!csvRows.length||IS_READONLY) return;
    const btn=document.getElementById('csv-import-btn'); btn.disabled=true; btn.textContent='Importing…';
    try {
      const d = await fetch('/api/broker/radar/prospects/import',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({prospects: csvRows})
      }).then(r=>r.json());
      if(d.success) {
        const s=document.getElementById('import-summary');
        s.innerHTML='<span class="ok">✅ '+d.imported+' imported</span>  <span class="skip">⏭ '+d.skipped+' skipped</span>'+(d.errors&&d.errors.length?'  <span class="err">⚠️ '+d.errors.length+' errors</span>':'');
        s.style.display='block';
        document.getElementById('csv-import-btn').style.display='none';
        csvRows=[];
        await Promise.all([loadStats(),loadSignalFeed(''),loadProspects('')]);
      } else {
        const e=document.getElementById('csv-error'); e.textContent=d.message||'Import failed'; e.style.display='block';
        btn.disabled=false; btn.textContent='Import Prospects';
      }
    } catch(e) {
      const el=document.getElementById('csv-error'); el.textContent='Network error'; el.style.display='block';
      btn.disabled=false; btn.textContent='Import Prospects';
    }
  }

  // ── DRAG & DROP ───────────────────────────────────────────────────────────────
  const dz = document.getElementById('drop-zone');
  if(dz) {
    dz.addEventListener('dragover', e=>{e.preventDefault();dz.classList.add('drag-over');});
    dz.addEventListener('dragleave', ()=>dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e=>{e.preventDefault();dz.classList.remove('drag-over');const f=e.dataTransfer.files[0];if(f)handleCsvFile(f);});
  }

  // ── MODAL CLOSE ON OVERLAY CLICK ─────────────────────────────────────────────
  ['add-modal','csv-modal','detail-modal'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');});
  });
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape') ['add-modal','csv-modal','detail-modal'].forEach(id=>document.getElementById(id).classList.remove('open'));
  });

  // ── GLOBE ─────────────────────────────────────────────────────────────────────
  const CITY_COORDS = {
    'london': [51.5074, -0.1278], 'london, uk': [51.5074, -0.1278], 'london, england': [51.5074, -0.1278],
    'dublin': [53.3331, -6.2489], 'paris': [48.8566, 2.3522], 'paris, france': [48.8566, 2.3522],
    'monaco': [43.7384, 7.4246], 'monte carlo': [43.7384, 7.4246],
    'frankfurt': [50.1109, 8.6821], 'hamburg': [53.5488, 9.9872], 'munich': [48.1351, 11.5820], 'berlin': [52.5200, 13.4050],
    'zurich': [47.3769, 8.5417], 'geneva': [46.2044, 6.1432], 'vienna': [48.2082, 16.3738],
    'stockholm': [59.3293, 18.0686], 'oslo': [59.9139, 10.7522], 'copenhagen': [55.6761, 12.5683], 'helsinki': [60.1699, 24.9384],
    'athens': [37.9838, 23.7275], 'piraeus': [37.9428, 23.6468],
    'milan': [45.4654, 9.1859], 'rome': [41.9028, 12.4964], 'florence': [43.7696, 11.2558], 'venice': [45.4408, 12.3155],
    'madrid': [40.4168, -3.7038], 'barcelona': [41.3851, 2.1734], 'lisbon': [38.7169, -9.1395],
    'moscow': [55.7558, 37.6173], 'st. petersburg': [59.9311, 30.3609], 'limassol': [34.6841, 33.0373],
    'dubai': [25.2048, 55.2708], 'dubai, uae': [25.2048, 55.2708], 'abu dhabi': [24.4539, 54.3773],
    'doha': [25.2854, 51.5310], 'doha, qatar': [25.2854, 51.5310], 'riyadh': [24.7136, 46.6753], 'kuwait city': [29.3759, 47.9774], 'tel aviv': [32.0853, 34.7818],
    'hong kong': [22.3193, 114.1694], 'singapore': [1.3521, 103.8198], 'tokyo': [35.6762, 139.6503],
    'osaka': [34.6937, 135.5023], 'shanghai': [31.2304, 121.4737], 'beijing': [39.9042, 116.4074],
    'seoul': [37.5665, 126.9780], 'mumbai': [19.0760, 72.8777], 'new delhi': [28.6139, 77.2090],
    'sydney': [-33.8688, 151.2093], 'melbourne': [-37.8136, 144.9631], 'kuala lumpur': [3.1390, 101.6869], 'bangkok': [13.7563, 100.5018],
    'new york': [40.7128, -74.0060], 'new york city': [40.7128, -74.0060], 'los angeles': [34.0522, -118.2437],
    'miami': [25.7617, -80.1918], 'chicago': [41.8781, -87.6298], 'san francisco': [37.7749, -122.4194],
    'boston': [42.3601, -71.0589], 'seattle': [47.6062, -122.3321], 'palo alto': [37.4419, -122.1430],
    'greenwich': [41.0262, -73.6282], 'greenwich, ct': [41.0262, -73.6282],
    'toronto': [43.6510, -79.3470], 'montreal': [45.5017, -73.5673], 'vancouver': [49.2827, -123.1207],
    'sao paulo': [-23.5505, -46.6333], 'rio de janeiro': [-22.9068, -43.1729], 'buenos aires': [-34.6037, -58.3816],
    'mexico city': [19.4326, -99.1332], 'johannesburg': [-26.2041, 28.0473], 'cape town': [-33.9249, 18.4241],
    'nairobi': [-1.2921, 36.8219], 'lagos': [6.5244, 3.3792], 'cairo': [30.0444, 31.2357],
    'uk': [55.3781, -3.4360], 'united kingdom': [55.3781, -3.4360], 'usa': [37.0902, -95.7129], 'united states': [37.0902, -95.7129],
    'germany': [51.1657, 10.4515], 'france': [46.2276, 2.2137], 'italy': [41.8719, 12.5674], 'spain': [40.4637, -3.7492],
    'russia': [61.5240, 105.3188], 'china': [35.8617, 104.1954], 'japan': [36.2048, 138.2529], 'india': [20.5937, 78.9629],
    'australia': [-25.2744, 133.7751], 'brazil': [-14.2350, -51.9253], 'canada': [56.1304, -106.3468],
    'switzerland': [46.8182, 8.2275], 'austria': [47.5162, 14.5501], 'uae': [23.4241, 53.8478],
    'saudi arabia': [23.8859, 45.0792], 'qatar': [25.3548, 51.1839], 'cyprus': [35.1264, 33.4299],
  };

  function geocodeLocation(loc) {
    if (!loc) return null;
    const key = loc.toLowerCase().trim();
    if (CITY_COORDS[key]) { const [lat, lng] = CITY_COORDS[key]; return { lat, lng }; }
    const parts = key.split(',').map(p => p.trim());
    for (const part of parts) {
      if (CITY_COORDS[part]) { const [lat, lng] = CITY_COORDS[part]; return { lat, lng }; }
    }
    for (const [k, v] of Object.entries(CITY_COORDS)) {
      if (k.startsWith(parts[0])) { const [lat, lng] = v; return { lat, lng }; }
    }
    return null;
  }

  function mapProspectsForGlobe(prospects, tier) {
    return prospects.map(p => {
      const coords = geocodeLocation(p.location);
      return { name: p.name || 'Unknown', company: p.company || '', loc: p.location || '', score: p.heat_score || 0, lat: coords ? coords.lat : 0, lng: coords ? coords.lng : 0, _hasCoords: !!coords };
    }).filter(p => p._hasCoords);
  }

  function groupProspectsByTier(flatList) {
    return {
      hot:  flatList.filter(p => p.heat_tier === 'hot'),
      warm: flatList.filter(p => p.heat_tier === 'warm'),
      cold: flatList.filter(p => p.heat_tier === 'cold'),
    };
  }

  async function initGlobe() {
    window._globeReady = true;
    const canvas = document.getElementById('globe-canvas');
    if (!canvas || typeof THREE === 'undefined' || typeof topojson === 'undefined') {
      console.warn('Globe: canvas or libraries not ready');
      window._globeReady = false;
      return;
    }
    const container = canvas.parentElement;
    const W = container.clientWidth;
    const H = container.clientHeight;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 1000);
    camera.position.set(0, 0, 2.8);
    const earth = new THREE.Group();
    scene.add(earth);
    const R = 1.0;
    function ll2v(lon, lat, r) {
      const phi   = (90 - lat)  * (Math.PI / 180);
      const theta = (lon + 180) * (Math.PI / 180);
      return new THREE.Vector3(
        -r * Math.sin(phi) * Math.cos(theta),
         r * Math.cos(phi),
         r * Math.sin(phi) * Math.sin(theta)
      );
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 2) pts.push(ll2v(lon, lat, R));
      earth.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: lat === 0 ? 0x00ccff : 0x1a5a8a, transparent: true, opacity: lat === 0 ? 0.5 : 0.18 })));
    }
    for (let lon = -180; lon < 180; lon += 15) {
      const pts = [];
      for (let lat = -90; lat <= 90; lat += 2) pts.push(ll2v(lon, lat, R));
      earth.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x1a5a8a, transparent: true, opacity: 0.18 })));
    }
    earth.add(new THREE.Mesh(new THREE.SphereGeometry(R, 64, 64), new THREE.MeshBasicMaterial({ color: 0x062d5f, transparent: true, opacity: 0.92 })));
    [[R+0.04, 0x1a7aff, 0.18], [R+0.10, 0x0055ff, 0.12], [R+0.22, 0x003ab5, 0.07]].forEach(function(a) {
      scene.add(new THREE.Mesh(new THREE.SphereGeometry(a[0], 64, 64), new THREE.MeshBasicMaterial({ color: a[1], transparent: true, opacity: a[2], side: THREE.BackSide })));
    });
    try {
      const topo = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(r => r.json());
      const countries = topojson.feature(topo, topo.objects.countries);
      const borderMat = new THREE.LineBasicMaterial({ color: 0x5ec8ff, transparent: true, opacity: 0.75 });
      function addGeoLine(coordinates) {
        if (coordinates.length < 2) return;
        const pts = coordinates.map(function(c) { return ll2v(c[0], c[1], R + 0.003); });
        let segment = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
          if (Math.abs(coordinates[i-1][0] - coordinates[i][0]) > 170) {
            if (segment.length >= 2) earth.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(segment), borderMat));
            segment = [pts[i]];
          } else { segment.push(pts[i]); }
        }
        if (segment.length >= 2) earth.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(segment), borderMat));
      }
      countries.features.forEach(function(f) {
        const g = f.geometry;
        if (!g) return;
        if (g.type === 'Polygon') g.coordinates.forEach(function(r) { addGeoLine(r); });
        else if (g.type === 'MultiPolygon') g.coordinates.forEach(function(p) { p.forEach(function(r) { addGeoLine(r); }); });
      });
    } catch(e) { console.warn('Globe: failed to load country borders', e); }
    const sv = [];
    for (let i = 0; i < 1500; i++) {
      const r = 5 + Math.random() * 5, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
      sv.push(r*Math.sin(p)*Math.cos(t), r*Math.cos(p), r*Math.sin(p)*Math.sin(t));
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.015, transparent: true, opacity: 0.35 })));
    const tierConfig = {
      hot:  { color: 0xff1111, glow1: 0xff2222, glow2: 0xff0000, coreSize: 0.016, g1Size: 0.035, g2Size: 0.062, g1Opacity: 0.35, g2Opacity: 0.10,
              btnBg: 'rgba(255,40,40,0.18)', btnBorder: 'rgba(255,50,50,0.6)', btnColor: '#ff4444', dotBg: '#ff3333', dotShadow: '#ff3333' },
      warm: { color: 0xff8c00, glow1: 0xff9900, glow2: 0xff7700, coreSize: 0.013, g1Size: 0.028, g2Size: 0.050, g1Opacity: 0.28, g2Opacity: 0.08,
              btnBg: 'rgba(255,140,0,0.18)', btnBorder: 'rgba(255,140,0,0.6)', btnColor: '#ff9900', dotBg: '#ff8c00', dotShadow: '#ff8c00' },
      cold: { color: 0xffdd00, glow1: 0xffee00, glow2: 0xffcc00, coreSize: 0.010, g1Size: 0.022, g2Size: 0.038, g1Opacity: 0.28, g2Opacity: 0.08,
              btnBg: 'rgba(255,220,0,0.14)', btnBorder: 'rgba(255,220,0,0.55)', btnColor: '#ffcc00', dotBg: '#ffdd00', dotShadow: '#ffdd00' },
    };
    const activeState = { hot: true, warm: false, cold: false };
    let tierGroups = { hot: [], warm: [], cold: [] };
    let glowPulse = [];
    let pickTargets = [];
    function clearTierDots(tier) {
      tierGroups[tier].forEach(function(m) { earth.remove(m); if (m.geometry) m.geometry.dispose(); });
      tierGroups[tier] = [];
      glowPulse = glowPulse.filter(function(g) { return g.tier !== tier; });
      pickTargets = pickTargets.filter(function(m) { return (m.userData.tier || '') !== tier; });
    }
    function buildTierDots(tier, prospects) {
      clearTierDots(tier);
      const cfg = tierConfig[tier];
      const group = [];
      prospects.forEach(function(p, i) {
        const surfPos = ll2v(p.lng, p.lat, R).normalize().multiplyScalar(R + 0.012);
        const spike = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([ll2v(p.lng, p.lat, R).normalize().multiplyScalar(R), ll2v(p.lng, p.lat, R).normalize().multiplyScalar(R + 0.022)]),
          new THREE.LineBasicMaterial({ color: cfg.glow1, transparent: true, opacity: 0.55 })
        );
        spike.userData = { tier }; earth.add(spike); group.push(spike);
        const core = new THREE.Mesh(new THREE.SphereGeometry(cfg.coreSize, 10, 10), new THREE.MeshBasicMaterial({ color: cfg.color }));
        core.position.copy(surfPos); core.userData = { prospect: p, tier };
        earth.add(core); group.push(core); pickTargets.push(core);
        const g1Mat = new THREE.MeshBasicMaterial({ color: cfg.glow1, transparent: true, opacity: cfg.g1Opacity });
        const g1 = new THREE.Mesh(new THREE.SphereGeometry(cfg.g1Size, 10, 10), g1Mat);
        g1.position.copy(surfPos); g1.userData = { tier }; earth.add(g1); group.push(g1);
        glowPulse.push({ mesh: g1, mat: g1Mat, baseOpacity: cfg.g1Opacity, speed: 2.5, phase: i * 1.4, tier });
        const g2Mat = new THREE.MeshBasicMaterial({ color: cfg.glow2, transparent: true, opacity: cfg.g2Opacity });
        const g2 = new THREE.Mesh(new THREE.SphereGeometry(cfg.g2Size, 10, 10), g2Mat);
        g2.position.copy(surfPos); g2.userData = { tier }; earth.add(g2); group.push(g2);
        glowPulse.push({ mesh: g2, mat: g2Mat, baseOpacity: cfg.g2Opacity, speed: 1.8, phase: i * 1.4 + 0.8, tier });
        tierGroups[tier] = group;
      });
    }
    function loadGlobeData(groupedProspects) {
      var tiers = ['hot', 'warm', 'cold'];
      tiers.forEach(function(tier) {
        const raw = groupedProspects ? (groupedProspects[tier] || []) : [];
        const mapped = mapProspectsForGlobe(raw, tier);
        buildTierDots(tier, mapped);
        const btn = document.getElementById('btn-tier-' + tier);
        if (btn) { const countSpan = btn.querySelector('span:last-child'); if (countSpan) countSpan.textContent = '(' + raw.length + ')'; }
      });
      applyVisibility();
    }
    window.updateGlobeDots = function(flatProspects) {
      loadGlobeData(groupProspectsByTier(flatProspects || []));
    };
    function applyVisibility() {
      Object.keys(tierGroups).forEach(function(t) { tierGroups[t].forEach(function(m) { m.visible = !!activeState[t]; }); });
      pickTargets.forEach(function(m) { m.visible = !!(activeState[m.userData.tier]); });
    }
    function updateButtonStyle(tier, active) {
      const btn = document.getElementById('btn-tier-' + tier);
      if (!btn) return;
      const cfg = tierConfig[tier];
      const dot = btn.querySelector('.tier-dot');
      if (active) {
        btn.style.background = cfg.btnBg; btn.style.border = '1.5px solid ' + cfg.btnBorder; btn.style.color = cfg.btnColor;
        if (dot) { dot.style.background = cfg.dotBg; dot.style.boxShadow = '0 0 6px ' + cfg.dotShadow; }
      } else {
        btn.style.background = 'rgba(40,40,40,0.3)'; btn.style.border = '1.5px solid rgba(255,255,255,0.1)'; btn.style.color = 'rgba(255,255,255,0.25)';
        if (dot) { dot.style.background = 'rgba(255,255,255,0.15)'; dot.style.boxShadow = 'none'; }
      }
    }
    function toggleTier(tier) {
      activeState[tier] = !activeState[tier];
      updateButtonStyle(tier, activeState[tier]);
      applyVisibility();
    }
    ['hot','warm','cold'].forEach(function(tier) {
      const btn = document.getElementById('btn-tier-' + tier);
      if (btn) btn.addEventListener('click', function() { toggleTier(tier); });
      updateButtonStyle(tier, activeState[tier]);
    });
    let autoRotate = true;
    const rotBtn = document.getElementById('btn-rotation');
    if (rotBtn) rotBtn.addEventListener('click', function() {
      autoRotate = !autoRotate;
      document.getElementById('btn-rotation-icon').textContent = autoRotate ? '⏸' : '▶';
      document.getElementById('btn-rotation-label').textContent = autoRotate ? 'STOP' : 'SPIN';
    });
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const tooltip = document.getElementById('globe-tooltip');
    canvas.addEventListener('mousemove', function(e) {
      if (!tooltip) return;
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(pickTargets);
      if (hits.length > 0) {
        const p = hits[0].object.userData.prospect;
        if (p) {
          const tierColors = { hot: '#ff4444', warm: '#ff9900', cold: '#ffcc00' };
          document.getElementById('tt-name').textContent = p.name;
          document.getElementById('tt-company').textContent = p.company || '';
          document.getElementById('tt-location').textContent = p.loc || '';
          document.getElementById('tt-score').innerHTML = '<span style="color:' + (tierColors[hits[0].object.userData.tier] || '#fff') + '">' + (hits[0].object.userData.tier || '').toUpperCase() + '</span> — Score: ' + Math.round(p.score);
          tooltip.style.display = 'block';
          tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
          tooltip.style.top = (e.clientY - rect.top - 40) + 'px';
          canvas.style.cursor = 'pointer';
        }
      } else {
        tooltip.style.display = 'none';
        canvas.style.cursor = 'grab';
      }
    });
    canvas.addEventListener('mouseleave', function() { if (tooltip) tooltip.style.display = 'none'; });
    let isDragging = false;
    let lastMouse = { x: 0, y: 0 };
    canvas.addEventListener('mousedown', function(e) { isDragging = true; lastMouse = { x: e.clientX, y: e.clientY }; canvas.style.cursor = 'grabbing'; });
    window.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      earth.rotation.y += (e.clientX - lastMouse.x) * 0.006;
      earth.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, earth.rotation.x + (e.clientY - lastMouse.y) * 0.006));
      lastMouse = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', function() { isDragging = false; canvas.style.cursor = 'grab'; });
    canvas.style.cursor = 'grab';
    let t = 0;
    (function animate() {
      requestAnimationFrame(animate);
      t += 0.016;
      if (autoRotate && !isDragging) earth.rotation.y += 0.0018;
      glowPulse.forEach(function(g) {
        if (!activeState[g.tier]) return;
        const s = Math.sin(t * g.speed + g.phase);
        g.mat.opacity = g.baseOpacity * (0.5 + 0.5 * s);
        g.mesh.scale.setScalar(1.0 + 0.5 * (0.5 + 0.5 * s));
      });
      renderer.render(scene, camera);
    })();
    new ResizeObserver(function() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }).observe(container);
    try {
      const r = await fetch('/api/broker/radar/prospects');
      const data = await r.json();
      if (data.success && data.prospects && data.prospects.length > 0) {
        loadGlobeData(groupProspectsByTier(data.prospects));
      }
    } catch(e) {
      console.warn('Globe: failed to load prospect data', e);
    }
  }

  // ── INIT ──────────────────────────────────────────────────────────────────────
  Promise.all([loadStats(), loadSignalFeed(''), loadScannerStatus()]);
  initGlobe();
</script>
</body>
</html>`);
});

// GET /broker/settings/branding — white-label branding settings (admin only)
app.get('/broker/settings/branding', async (req, res) => {
  if (!req.session || !req.session.brokerUser) return res.redirect('/broker/login');
  const user = req.session.brokerUser;
  const tenant = req.session.brokerTenant;

  if (user.role !== 'admin') {
    return res.redirect('/broker/dashboard');
  }

  const brandColor = getBrandColor(tenant);
  const displayName = getDisplayName(tenant);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Brand Settings — ${displayName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  ${brandColorStyles(tenant)}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0f1e; --surface: #111827; --surface2: #1a2236;
      --border: #1e2d45; --border2: #263552;
      --text: #e8edf5; --text2: #8fa3bf; --text3: #4d6480;
    }
    body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }

    .topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 100; background: rgba(10,15,30,0.95); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); height: 54px; display: flex; align-items: center; padding: 0 28px; gap: 0; }
    .topbar-nav { display: flex; align-items: center; gap: 4px; flex: 1; margin-left: 16px; }
    .topbar-nav a { color: var(--text2); text-decoration: none; font-size: 13px; font-weight: 500; padding: 6px 14px; border-radius: 6px; transition: all 0.15s; }
    .topbar-nav a:hover { color: var(--text); background: var(--surface2); }
    .topbar-nav a.active { color: var(--text); background: var(--surface2); }
    .topbar-right { display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--text3); }
    .topbar-right a { color: var(--text3); text-decoration: none; }
    .topbar-right a:hover { color: var(--text2); }

    .page { padding-top: 54px; }
    .container { max-width: 720px; margin: 0 auto; padding: 36px 28px 80px; }

    h1 { font-size: 22px; font-weight: 700; color: var(--text); margin-bottom: 6px; }
    .subtitle { font-size: 14px; color: var(--text2); margin-bottom: 32px; }

    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px; margin-bottom: 20px; }
    .card h2 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 18px; display: flex; align-items: center; gap: 8px; }
    .card h2 .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: var(--surface2); color: var(--text2); }

    .form-group { margin-bottom: 20px; }
    label { display: block; font-size: 13px; font-weight: 500; color: var(--text2); margin-bottom: 7px; }
    input[type="text"] { width: 100%; background: var(--bg); border: 1px solid var(--border2); border-radius: 8px; padding: 10px 14px; font-size: 14px; color: var(--text); outline: none; transition: border-color 0.2s; }
    input[type="text"]:focus { border-color: var(--brand, #c9a84c); }
    .hint { font-size: 12px; color: var(--text3); margin-top: 5px; }

    .color-row { display: flex; align-items: center; gap: 12px; }
    .color-preview { width: 40px; height: 40px; border-radius: 8px; border: 1px solid var(--border2); flex-shrink: 0; transition: background 0.2s; }
    .color-input-wrap { position: relative; flex: 1; }
    .color-hex { width: 100%; background: var(--bg); border: 1px solid var(--border2); border-radius: 8px; padding: 10px 14px 10px 42px; font-size: 14px; color: var(--text); font-family: monospace; outline: none; transition: border-color 0.2s; }
    .color-hex:focus { border-color: var(--brand, #c9a84c); }
    .color-swatch { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--border2); cursor: pointer; overflow: hidden; }
    .color-swatch input[type="color"] { position: absolute; top: -4px; left: -4px; width: 32px; height: 32px; border: none; padding: 0; cursor: pointer; opacity: 0; }
    .swatch-circle { position: absolute; inset: 0; border-radius: 4px; pointer-events: none; }

    .logo-section { display: flex; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
    .logo-preview-box { width: 120px; height: 80px; background: var(--bg); border: 1px solid var(--border2); border-radius: 10px; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
    .logo-preview-box img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .logo-placeholder { color: var(--text3); font-size: 12px; text-align: center; padding: 8px; }
    .logo-controls { flex: 1; min-width: 180px; }
    .logo-controls p { font-size: 13px; color: var(--text2); margin-bottom: 12px; }
    .upload-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--surface2); border: 1px solid var(--border2); color: var(--text); padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
    .upload-btn:hover { border-color: var(--brand, #c9a84c); color: var(--brand, #c9a84c); }
    .remove-btn { display: inline-flex; align-items: center; gap: 6px; background: transparent; border: 1px solid #7f1d1d; color: #fca5a5; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; margin-left: 8px; }
    .remove-btn:hover { background: #450a0a; }

    .btn-row { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
    .btn-save { background: var(--brand, #c9a84c); color: #0f172a; border: none; padding: 10px 24px; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; transition: opacity 0.2s; }
    .btn-save:hover { opacity: 0.88; }
    .btn-save:disabled { opacity: 0.4; cursor: not-allowed; }

    .feedback { font-size: 13px; padding: 8px 14px; border-radius: 7px; display: none; }
    .feedback.ok { background: #052e16; border: 1px solid #14532d; color: #86efac; }
    .feedback.err { background: #450a0a; border: 1px solid #7f1d1d; color: #fca5a5; }

    .preview-bar { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 20px; display: flex; align-items: center; gap: 16px; margin-top: 12px; }
    .preview-label { font-size: 12px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.5px; margin-right: 8px; }

    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    .saving { animation: pulse 1s infinite; }
  </style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      ${topbarLogoHtml(tenant, 24)}
      <nav class="topbar-nav">
        <a href="/broker/signal-radar">Signal Radar</a>
        <a href="/broker/dashboard">Dashboard</a>
        <a href="/broker/settings/branding" class="active">Brand Settings</a>
        <a href="/broker/billing">Billing</a>
      </nav>
      <div class="topbar-right">
        <span>${user.first_name || user.email}</span>
        <a href="/api/broker/logout">Sign out</a>
      </div>
    </div>

    <div class="container">
      <h1>Brand Settings</h1>
      <p class="subtitle">Customize how your workspace looks to your team and clients.</p>

      <!-- Logo -->
      <div class="card">
        <h2>🖼️ Logo</h2>
        <div class="logo-section">
          <div class="logo-preview-box" id="logo-preview-box">
            ${tenant.logo_url
              ? `<img src="${tenant.logo_url}" id="logo-preview-img" alt="Logo">`
              : `<div class="logo-placeholder" id="logo-placeholder">No logo<br>uploaded</div>`
            }
            ${tenant.logo_url ? '' : '<img id="logo-preview-img" style="display:none" alt="Logo">'}
          </div>
          <div class="logo-controls">
            <p>Upload your company logo. PNG, JPG or SVG recommended. Max 500KB.</p>
            <input type="file" id="logo-file-input" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" style="display:none">
            <label class="upload-btn" for="logo-file-input">📁 Choose file</label>
            ${tenant.logo_url ? `<button class="remove-btn" id="remove-logo-btn" onclick="removeLogo()">✕ Remove</button>` : `<button class="remove-btn" id="remove-logo-btn" onclick="removeLogo()" style="display:none">✕ Remove</button>`}
            <div id="logo-feedback" class="feedback" style="margin-top:10px"></div>
          </div>
        </div>
      </div>

      <!-- Brand Color -->
      <div class="card">
        <h2>🎨 Brand Color</h2>
        <div class="form-group">
          <label>Primary Color</label>
          <div class="color-row">
            <div class="color-preview" id="color-preview" style="background:${brandColor}"></div>
            <div class="color-input-wrap">
              <div class="color-swatch" id="color-swatch" style="background:${brandColor}">
                <input type="color" id="color-picker" value="${brandColor}" oninput="onColorPick(this.value)">
                <div class="swatch-circle" id="swatch-circle" style="background:${brandColor}"></div>
              </div>
              <input type="text" class="color-hex" id="color-hex" value="${brandColor}" placeholder="#c9a84c" maxlength="7" oninput="onHexInput(this.value)">
            </div>
          </div>
          <div class="hint">Used for header accents, buttons, and links across your workspace.</div>
        </div>

        <!-- Live preview bar -->
        <div class="preview-bar">
          <span class="preview-label">Preview</span>
          <span id="preview-name" style="font-weight:700;color:${brandColor};font-size:14px">${displayName}</span>
          <button id="preview-btn" style="background:${brandColor};color:#0f172a;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:default;">Save Changes</button>
        </div>

        <div class="btn-row" style="margin-top:20px">
          <button class="btn-save" id="save-color-btn" onclick="saveColor()">Save Color</button>
          <div id="color-feedback" class="feedback"></div>
        </div>
      </div>

      <!-- Display Name -->
      <div class="card">
        <h2>🏢 Display Name</h2>
        <div class="form-group">
          <label>Company Display Name</label>
          <input type="text" id="display-name" value="${(tenant.company_display_name || '').replace(/"/g, '&quot;')}" placeholder="${tenant.name}" maxlength="255">
          <div class="hint">Shown in the header and login page. Defaults to your workspace name: <strong>${tenant.name}</strong></div>
        </div>
        <div class="btn-row">
          <button class="btn-save" id="save-name-btn" onclick="saveName()">Save Name</button>
          <div id="name-feedback" class="feedback"></div>
        </div>
      </div>

    </div>
  </div>

  <script>
    // ── Color picker ──────────────────────────────────────────────────────────
    function onColorPick(val) {
      document.getElementById('color-hex').value = val;
      applyColorPreview(val);
    }
    function onHexInput(val) {
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        document.getElementById('color-picker').value = val;
        applyColorPreview(val);
      }
    }
    function applyColorPreview(color) {
      document.getElementById('color-preview').style.background = color;
      document.getElementById('swatch-circle').style.background = color;
      document.getElementById('color-swatch').style.background = color;
      document.getElementById('preview-name').style.color = color;
      document.getElementById('preview-btn').style.background = color;
    }

    async function saveColor() {
      const color = document.getElementById('color-hex').value.trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        showFeedback('color-feedback', 'err', 'Enter a valid hex color like #c9a84c');
        return;
      }
      const btn = document.getElementById('save-color-btn');
      btn.disabled = true; btn.classList.add('saving');
      try {
        const r = await fetch('/api/broker/branding', {
          method: 'PUT', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ primary_color: color })
        });
        const d = await r.json();
        if (d.success) {
          showFeedback('color-feedback', 'ok', '✓ Brand color saved');
          // Update CSS var live
          document.documentElement.style.setProperty('--brand', color);
        } else {
          showFeedback('color-feedback', 'err', d.message);
        }
      } catch(e) { showFeedback('color-feedback', 'err', 'Network error'); }
      btn.disabled = false; btn.classList.remove('saving');
    }

    // ── Display name ─────────────────────────────────────────────────────────
    async function saveName() {
      const name = document.getElementById('display-name').value.trim();
      const btn = document.getElementById('save-name-btn');
      btn.disabled = true; btn.classList.add('saving');
      try {
        const r = await fetch('/api/broker/branding', {
          method: 'PUT', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ company_display_name: name })
        });
        const d = await r.json();
        if (d.success) {
          showFeedback('name-feedback', 'ok', '✓ Display name saved');
        } else {
          showFeedback('name-feedback', 'err', d.message);
        }
      } catch(e) { showFeedback('name-feedback', 'err', 'Network error'); }
      btn.disabled = false; btn.classList.remove('saving');
    }

    // ── Logo upload ───────────────────────────────────────────────────────────
    document.getElementById('logo-file-input').addEventListener('change', async function(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 512000) {
        showFeedback('logo-feedback', 'err', 'File too large. Max 500KB.');
        return;
      }
      showFeedback('logo-feedback', 'ok', 'Uploading…');
      const reader = new FileReader();
      reader.onload = async function(ev) {
        const base64 = ev.target.result;
        try {
          const r = await fetch('/api/broker/branding/logo', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ logo_data: base64, mime_type: file.type })
          });
          const d = await r.json();
          if (d.success) {
            document.getElementById('logo-preview-img').src = d.logo_url;
            document.getElementById('logo-preview-img').style.display = '';
            const ph = document.getElementById('logo-placeholder');
            if (ph) ph.style.display = 'none';
            document.getElementById('remove-logo-btn').style.display = '';
            showFeedback('logo-feedback', 'ok', '✓ Logo uploaded successfully');
          } else {
            showFeedback('logo-feedback', 'err', d.message);
          }
        } catch(ex) { showFeedback('logo-feedback', 'err', 'Upload failed. Try again.'); }
      };
      reader.readAsDataURL(file);
    });

    async function removeLogo() {
      if (!confirm('Remove logo?')) return;
      try {
        const r = await fetch('/api/broker/branding/logo', { method: 'DELETE' });
        const d = await r.json();
        if (d.success) {
          document.getElementById('logo-preview-img').src = '';
          document.getElementById('logo-preview-img').style.display = 'none';
          const ph = document.getElementById('logo-placeholder');
          if (ph) ph.style.display = '';
          document.getElementById('remove-logo-btn').style.display = 'none';
          showFeedback('logo-feedback', 'ok', 'Logo removed');
        }
      } catch(e) { showFeedback('logo-feedback', 'err', 'Failed to remove logo'); }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────
    function showFeedback(id, type, msg) {
      const el = document.getElementById(id);
      el.className = 'feedback ' + type;
      el.textContent = msg;
      el.style.display = 'block';
      if (type === 'ok') setTimeout(() => { el.style.display = 'none'; }, 3500);
    }
  </script>
</body>
</html>`);
});

// GET /broker/billing — billing settings page
app.get('/broker/billing', async (req, res) => {
  if (!req.session || !req.session.brokerUser) return res.redirect('/broker/login');
  const user = req.session.brokerUser;
  const tenant = req.session.brokerTenant;

  // Refresh billing status from DB
  let billingData = { billing_status: tenant.billing_status || 'trial', trial_ends_at: tenant.trial_ends_at, subscription_started_at: tenant.subscription_started_at };
  try {
    const { rows } = await pool.query(
      `SELECT billing_status, trial_ends_at, subscription_started_at FROM tenants WHERE id = $1`,
      [tenant.id]
    );
    if (rows.length > 0) {
      billingData = rows[0];
      // Auto-expire trial
      const status = effectiveBillingStatus(billingData);
      if (status === 'past_due' && billingData.billing_status === 'trial') {
        await pool.query(`UPDATE tenants SET billing_status = 'past_due' WHERE id = $1`, [tenant.id]);
        billingData.billing_status = 'past_due';
      }
      req.session.brokerTenant.billing_status = billingData.billing_status;
      req.session.brokerTenant.trial_ends_at = billingData.trial_ends_at;
    }
  } catch (e) { console.error('[Billing page] DB error:', e.message); }

  const status = effectiveBillingStatus(billingData);
  const daysLeft = trialDaysRemaining(billingData);

  const statusLabel = status === 'active' ? '<span style="color:#86efac">● Active</span>'
    : status === 'trial' ? `<span style="color:#93c5fd">● Free Trial</span>`
    : status === 'past_due' ? '<span style="color:#fca5a5">● Payment Required</span>'
    : '<span style="color:#78716c">● Cancelled</span>';

  res.send(brokerPage('Billing & Subscription', `
  <style>body { display:block !important; }</style>
  <div style="max-width:600px;margin:0 auto;padding:40px 24px">
    <div style="margin-bottom:32px;display:flex;gap:20px;align-items:center">
      <a href="/broker/dashboard" style="color:#64748b;font-size:13px;text-decoration:none">← Back to Dashboard</a>
      ${user.role === 'admin' ? '<a href="/broker/settings/branding" style="color:#64748b;font-size:13px;text-decoration:none">⚙ Brand Settings</a>' : ''}
    </div>

    <h2 style="font-size:22px;font-weight:700;color:#f1f5f9;margin-bottom:8px">Billing & Subscription</h2>
    <p style="color:#64748b;font-size:14px;margin-bottom:32px">Manage your BarnesOS subscription</p>

    <!-- Current Plan Card -->
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px;margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px">
        <div>
          <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-bottom:6px">Current Plan</div>
          <div style="font-size:20px;font-weight:700;color:#f1f5f9">BarnesOS Broker</div>
          <div style="font-size:14px;color:#64748b;margin-top:4px">€100 / month · Full workspace access</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:12px;color:#64748b;margin-bottom:4px">Status</div>
          <div style="font-size:15px;font-weight:600">${statusLabel}</div>
        </div>
      </div>

      ${status === 'trial' ? `
      <div style="border-top:1px solid #334155;margin-top:20px;padding-top:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
          <div>
            <div style="font-size:13px;color:#94a3b8">Trial ends: <strong style="color:#f1f5f9">${billingData.trial_ends_at ? new Date(billingData.trial_ends_at).toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'}) : '—'}</strong></div>
            <div style="font-size:13px;color:#94a3b8;margin-top:4px"><strong style="color:#f1f5f9">${daysLeft} days</strong> remaining</div>
          </div>
          <a href="${STRIPE_SUBSCRIPTION_URL}" target="_blank" style="background:#3b82f6;color:#fff;font-size:14px;font-weight:700;padding:10px 24px;border-radius:8px;text-decoration:none;display:inline-block">Subscribe — €100/mo →</a>
        </div>
      </div>` : ''}

      ${status === 'past_due' ? `
      <div style="background:#450a0a;border:1px solid #b91c1c;border-radius:8px;padding:16px;margin-top:20px">
        <p style="color:#fca5a5;font-size:14px;margin-bottom:12px">Your free trial has ended. Subscribe now to restore full access. Your data is safe and preserved.</p>
        <a href="${STRIPE_SUBSCRIPTION_URL}" target="_blank" style="background:#ef4444;color:#fff;font-size:14px;font-weight:700;padding:10px 24px;border-radius:8px;text-decoration:none;display:inline-block">Subscribe Now — €100/mo →</a>
      </div>` : ''}

      ${status === 'active' ? `
      <div style="border-top:1px solid #334155;margin-top:20px;padding-top:20px">
        <div style="font-size:13px;color:#94a3b8">Subscription started: <strong style="color:#f1f5f9">${billingData.subscription_started_at ? new Date(billingData.subscription_started_at).toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'}) : '—'}</strong></div>
        <div style="font-size:13px;color:#86efac;margin-top:8px">✓ Full access to all features</div>
      </div>` : ''}
    </div>

    <!-- What's included -->
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;margin-bottom:20px">
      <div style="font-size:13px;font-weight:600;color:#f1f5f9;margin-bottom:14px">What's included</div>
      <ul style="list-style:none;display:flex;flex-direction:column;gap:8px">
        ${['Yacht inventory management','Deal flow tracking','Signal radar (AI prospect intelligence)','Team collaboration (unlimited users)','Barnes OS cockpit & command center'].map(f => `<li style="font-size:13px;color:#94a3b8">✓ ${f}</li>`).join('')}
      </ul>
    </div>

    <div style="font-size:12px;color:#475569;text-align:center;margin-top:16px">
      Questions? Email <a href="mailto:support@barnesos.com" style="color:#60a5fa">support@barnesos.com</a>
    </div>
  </div>

  <script>
    // If user just paid and landed here via redirect, activate automatically
    (async () => {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('activated') === '1') {
        try {
          await fetch('/api/broker/billing/activate', { method: 'POST' });
          window.location.href = '/broker/billing?activated=done';
        } catch (e) {}
      }
    })();
  </script>`));
});

// GET /broker/billing/activated — Stripe success redirect page
app.get('/broker/billing/activated', async (req, res) => {
  if (!req.session || !req.session.brokerUser) {
    // Not logged in — redirect to login with a message
    return res.redirect('/broker/login?msg=Payment+successful!+Please+sign+in+to+activate+your+account.');
  }

  // Activate the subscription
  try {
    await pool.query(
      `UPDATE tenants SET billing_status = 'active', subscription_started_at = COALESCE(subscription_started_at, NOW()) WHERE id = $1`,
      [req.session.brokerTenant.id]
    );
    req.session.brokerTenant.billing_status = 'active';
  } catch (e) {
    console.error('[Billing] Activation error:', e.message);
  }

  res.send(brokerPage('Subscription Active!', `
  <div class="card" style="text-align:center">
    <div style="font-size:56px;margin-bottom:16px">🎉</div>
    <h1 style="font-size:22px;color:#f1f5f9;margin-bottom:8px">Subscription Active!</h1>
    <p style="color:#64748b;font-size:14px;margin-bottom:28px">You're all set. Full access to BarnesOS is now enabled for <strong style="color:#f1f5f9">${req.session.brokerTenant.name}</strong>.</p>
    <a href="/broker/dashboard" style="background:#3b82f6;color:#fff;font-size:14px;font-weight:700;padding:12px 32px;border-radius:8px;text-decoration:none;display:inline-block">Go to Dashboard →</a>
  </div>`));
});

// Redirect /broker → /broker/dashboard or /broker/login
app.get('/broker', (req, res) => {
  if (req.session && req.session.brokerUser) return res.redirect('/broker/dashboard');
  return res.redirect('/broker/login');
});

// ─── BROKER MARKETING LANDING PAGE ───────────────────────────────────────────
// Public marketing page at /brokers — no auth required
app.get('/brokers', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signal Radar for Yacht Brokers — Know When Your Clients Are Ready to Buy</title>
  <meta name="description" content="The only yacht brokerage platform with automated UHNWI buying signal detection. Upload your prospect list, get daily alerts. €100/month per brokerage.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --navy:   #0a1628;
      --deep:   #0d1f3c;
      --slate:  #1a2d4a;
      --slate2: #243d5c;
      --gold:   #c9a96e;
      --gold-l: #e0c99e;
      --gold-d: #9a7a48;
      --cream:  #f5f0e8;
      --white:  #ffffff;
      --mist:   #8a9bb5;
      --mist-d: #5a7090;
      --green:  #34d399;
      --border: rgba(201,169,110,0.15);
    }
    html { scroll-behavior: smooth; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--navy);
      color: var(--cream);
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }

    /* ── GRID BG ── */
    body::before {
      content: '';
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background:
        repeating-linear-gradient(-45deg, transparent, transparent 80px, rgba(201,169,110,0.025) 80px, rgba(201,169,110,0.025) 81px);
      pointer-events: none; z-index: 0;
    }

    /* ── LAYOUT ── */
    .container { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 0 24px; }
    section { position: relative; z-index: 1; }

    /* ── NAV ── */
    nav {
      position: sticky; top: 0; z-index: 500;
      background: rgba(10,22,40,0.9);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
    }
    .nav-inner {
      display: flex; align-items: center; justify-content: space-between;
      max-width: 1100px; margin: 0 auto; padding: 0 24px; height: 64px;
    }
    .nav-logo {
      font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px;
      letter-spacing: 1.5px; color: var(--cream); text-decoration: none;
      display: flex; align-items: center; gap: 10px;
    }
    .nav-logo span { color: var(--gold); }
    .nav-logo img { height: 32px; width: auto; }
    .nav-links { display: flex; align-items: center; gap: 8px; }
    .nav-link {
      color: var(--mist); text-decoration: none; font-size: 14px; font-weight: 500;
      padding: 7px 16px; border-radius: 6px; transition: all 0.2s;
    }
    .nav-link:hover { color: var(--cream); background: rgba(255,255,255,0.06); }
    .nav-cta {
      background: var(--gold); color: var(--navy); font-weight: 700; font-size: 14px;
      padding: 8px 20px; border-radius: 8px; text-decoration: none;
      transition: all 0.2s; white-space: nowrap;
    }
    .nav-cta:hover { background: var(--gold-l); transform: translateY(-1px); }
    @media(max-width:600px) { .nav-links .nav-link { display:none; } }

    /* ── HERO ── */
    .hero {
      padding: 100px 0 80px;
      text-align: center;
    }
    .hero-badge {
      display: inline-flex; align-items: center; gap: 8px;
      background: rgba(201,169,110,0.1); border: 1px solid var(--border);
      border-radius: 100px; padding: 6px 16px;
      font-size: 12px; font-weight: 600; letter-spacing: 0.08em;
      color: var(--gold); text-transform: uppercase; margin-bottom: 28px;
    }
    .hero-badge::before { content: '◆'; font-size: 8px; }
    .hero h1 {
      font-family: 'Syne', sans-serif; font-weight: 800;
      font-size: clamp(38px, 6vw, 68px);
      line-height: 1.08; letter-spacing: -1px;
      color: var(--white); margin-bottom: 24px;
    }
    .hero h1 em {
      font-style: normal;
      background: linear-gradient(135deg, var(--gold) 0%, var(--gold-l) 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .hero-sub {
      font-size: 19px; line-height: 1.6; color: var(--mist);
      max-width: 580px; margin: 0 auto 40px; font-weight: 400;
    }
    .hero-ctas { display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap; }
    .btn-primary {
      background: var(--gold); color: var(--navy); font-weight: 700; font-size: 16px;
      padding: 14px 32px; border-radius: 10px; text-decoration: none;
      display: inline-flex; align-items: center; gap: 8px;
      transition: all 0.2s; box-shadow: 0 4px 20px rgba(201,169,110,0.3);
    }
    .btn-primary:hover { background: var(--gold-l); transform: translateY(-2px); box-shadow: 0 8px 30px rgba(201,169,110,0.4); }
    .btn-secondary {
      background: transparent; color: var(--cream); font-weight: 600; font-size: 15px;
      padding: 13px 28px; border-radius: 10px; text-decoration: none;
      border: 1px solid rgba(255,255,255,0.15); transition: all 0.2s;
    }
    .btn-secondary:hover { border-color: var(--gold); color: var(--gold); }
    .hero-note { margin-top: 18px; color: var(--mist-d); font-size: 13px; }

    /* ── STATS BAR ── */
    .stats-bar {
      border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
      background: rgba(13,31,60,0.6);
      padding: 28px 0; margin: 60px 0 0;
    }
    .stats-inner {
      display: flex; align-items: center; justify-content: center;
      gap: 0; max-width: 1100px; margin: 0 auto; padding: 0 24px;
      flex-wrap: wrap;
    }
    .stat-item {
      flex: 1; min-width: 160px; text-align: center;
      padding: 8px 24px; border-right: 1px solid var(--border);
    }
    .stat-item:last-child { border-right: none; }
    .stat-num {
      font-family: 'Syne', sans-serif; font-weight: 800; font-size: 28px;
      color: var(--gold); display: block; line-height: 1.1;
    }
    .stat-label { font-size: 12px; color: var(--mist); letter-spacing: 0.05em; margin-top: 4px; }

    /* ── SECTION HEADER ── */
    .section-label {
      font-size: 11px; font-weight: 700; letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--gold); margin-bottom: 12px;
    }
    .section-title {
      font-family: 'Syne', sans-serif; font-weight: 800;
      font-size: clamp(28px, 4vw, 42px);
      color: var(--white); line-height: 1.15; letter-spacing: -0.5px;
    }
    .section-sub {
      font-size: 17px; color: var(--mist); line-height: 1.65;
      max-width: 600px; margin-top: 14px;
    }

    /* ── HOW IT WORKS ── */
    .how-section { padding: 100px 0; }
    .how-header { text-align: center; margin-bottom: 64px; }
    .how-grid {
      display: grid; grid-template-columns: repeat(3,1fr); gap: 2px;
      background: var(--border); border-radius: 16px; overflow: hidden;
    }
    @media(max-width:720px) { .how-grid { grid-template-columns: 1fr; } }
    .how-step {
      background: var(--deep);
      padding: 40px 32px; position: relative;
    }
    .step-num {
      font-family: 'Syne', sans-serif; font-weight: 800;
      font-size: 48px; color: rgba(201,169,110,0.1); line-height: 1;
      margin-bottom: 12px; display: block;
    }
    .step-icon {
      width: 48px; height: 48px; border-radius: 12px;
      background: rgba(201,169,110,0.12);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; margin-bottom: 20px;
    }
    .step-title {
      font-family: 'Syne', sans-serif; font-weight: 700;
      font-size: 18px; color: var(--white); margin-bottom: 10px;
    }
    .step-desc { font-size: 14px; color: var(--mist); line-height: 1.65; }
    .step-arrow {
      position: absolute; right: -16px; top: 50%;
      transform: translateY(-50%);
      width: 32px; height: 32px; border-radius: 50%;
      background: var(--slate); border: 2px solid var(--border);
      display: flex; align-items: center; justify-content: center;
      color: var(--gold); font-size: 14px; z-index: 2;
    }
    @media(max-width:720px) { .step-arrow { display:none; } }

    /* ── DIFFERENTIATOR ── */
    .diff-section {
      padding: 80px 0;
      background: linear-gradient(135deg, rgba(201,169,110,0.06) 0%, transparent 60%);
      border-radius: 24px; margin: 0 24px 0;
    }
    .diff-inner { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
    .diff-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 64px; align-items: center; }
    @media(max-width:760px) { .diff-grid { grid-template-columns: 1fr; gap: 40px; } }
    .diff-tag {
      display: inline-block;
      background: linear-gradient(135deg, rgba(201,169,110,0.2), rgba(201,169,110,0.05));
      border: 1px solid var(--gold-d); border-radius: 8px;
      padding: 6px 14px; font-size: 12px; font-weight: 700;
      color: var(--gold); letter-spacing: 0.06em; text-transform: uppercase;
      margin-bottom: 20px;
    }
    .diff-list { margin-top: 28px; display: flex; flex-direction: column; gap: 16px; }
    .diff-item { display: flex; gap: 14px; align-items: flex-start; }
    .diff-check {
      width: 22px; height: 22px; border-radius: 50%;
      background: rgba(52,211,153,0.15); border: 1px solid rgba(52,211,153,0.3);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 2px;
      font-size: 11px; color: var(--green);
    }
    .diff-text { font-size: 15px; color: var(--cream); line-height: 1.5; }
    .diff-text strong { color: var(--white); font-weight: 600; }

    /* Signal card visual */
    .signal-card {
      background: var(--slate); border: 1px solid var(--border);
      border-radius: 16px; padding: 28px; font-size: 14px;
    }
    .signal-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--border);
    }
    .signal-title { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 15px; color: var(--white); }
    .signal-badge {
      background: rgba(52,211,153,0.15); color: var(--green);
      border: 1px solid rgba(52,211,153,0.25);
      border-radius: 100px; padding: 3px 12px; font-size: 11px; font-weight: 700;
      letter-spacing: 0.06em;
    }
    .signal-row {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .signal-row:last-child { border-bottom: none; padding-bottom: 0; }
    .signal-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: linear-gradient(135deg, var(--slate2), var(--deep));
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 13px; color: var(--gold); flex-shrink: 0;
    }
    .signal-name { font-weight: 600; color: var(--cream); font-size: 14px; flex: 1; }
    .signal-sub { font-size: 12px; color: var(--mist); }
    .signal-score { text-align: right; }
    .score-dots { display: flex; gap: 4px; justify-content: flex-end; margin-bottom: 4px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot.hot { background: var(--gold); }
    .dot.warm { background: rgba(201,169,110,0.4); }
    .dot.cold { background: rgba(201,169,110,0.1); }
    .score-label { font-size: 11px; font-weight: 700; }
    .score-label.hot { color: var(--gold); }
    .score-label.warm { color: var(--mist); }
    .signal-reason { font-size: 12px; color: var(--mist); margin-top: 6px; line-height: 1.4; }

    /* ── FEATURES ── */
    .features-section { padding: 100px 0; }
    .features-header { margin-bottom: 56px; }
    .features-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 24px; }
    @media(max-width:900px) { .features-grid { grid-template-columns: repeat(2,1fr); } }
    @media(max-width:580px) { .features-grid { grid-template-columns: 1fr; } }
    .feature-card {
      background: var(--deep); border: 1px solid var(--border);
      border-radius: 14px; padding: 28px;
      transition: border-color 0.2s, transform 0.2s;
    }
    .feature-card:hover { border-color: var(--gold-d); transform: translateY(-3px); }
    .feature-icon {
      width: 44px; height: 44px; border-radius: 10px;
      background: rgba(201,169,110,0.1); display: flex;
      align-items: center; justify-content: center;
      font-size: 20px; margin-bottom: 16px;
    }
    .feature-title { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 16px; color: var(--white); margin-bottom: 8px; }
    .feature-desc { font-size: 14px; color: var(--mist); line-height: 1.65; }
    .feature-highlight {
      display: inline-block; margin-top: 12px;
      font-size: 12px; font-weight: 700; color: var(--gold);
      letter-spacing: 0.04em;
    }

    /* ── PRICING ── */
    .pricing-section { padding: 100px 0; text-align: center; }
    .pricing-card {
      max-width: 480px; margin: 48px auto 0;
      background: var(--deep); border: 2px solid var(--gold);
      border-radius: 20px; padding: 48px 40px; position: relative;
      box-shadow: 0 0 60px rgba(201,169,110,0.12);
    }
    .pricing-popular {
      position: absolute; top: -14px; left: 50%; transform: translateX(-50%);
      background: var(--gold); color: var(--navy); font-weight: 800;
      font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
      padding: 5px 20px; border-radius: 100px;
    }
    .price-amount {
      font-family: 'Syne', sans-serif; font-weight: 800; font-size: 64px;
      color: var(--white); line-height: 1; margin-bottom: 4px;
    }
    .price-currency { font-size: 32px; vertical-align: super; color: var(--gold); }
    .price-period { font-size: 15px; color: var(--mist); margin-bottom: 32px; }
    .price-features { list-style: none; text-align: left; margin-bottom: 36px; }
    .price-features li {
      display: flex; gap: 12px; align-items: flex-start;
      padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 15px; color: var(--cream);
    }
    .price-features li:last-child { border-bottom: none; }
    .price-check { color: var(--green); font-size: 16px; flex-shrink: 0; margin-top: 1px; }
    .pricing-note {
      margin-top: 20px; font-size: 13px; color: var(--mist-d);
    }

    /* ── TRUST ── */
    .trust-section { padding: 80px 0; }
    .trust-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 20px; margin-top: 48px; }
    @media(max-width:860px) { .trust-grid { grid-template-columns: repeat(2,1fr); } }
    @media(max-width:480px) { .trust-grid { grid-template-columns: 1fr; } }
    .trust-card {
      background: var(--deep); border: 1px solid var(--border);
      border-radius: 14px; padding: 24px;
      display: flex; flex-direction: column; align-items: flex-start; gap: 12px;
    }
    .trust-icon { font-size: 28px; }
    .trust-title { font-weight: 700; font-size: 15px; color: var(--white); }
    .trust-desc { font-size: 13px; color: var(--mist); line-height: 1.55; }

    /* ── FAQ ── */
    .faq-section { padding: 100px 0; }
    .faq-header { text-align: center; margin-bottom: 56px; }
    .faq-list { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 4px; }
    .faq-item {
      background: var(--deep); border: 1px solid var(--border);
      border-radius: 12px; overflow: hidden;
    }
    .faq-q {
      display: flex; align-items: center; justify-content: space-between;
      padding: 20px 24px; cursor: pointer; font-weight: 600; font-size: 15px;
      color: var(--cream); gap: 16px;
      user-select: none;
    }
    .faq-q:hover { background: rgba(255,255,255,0.03); }
    .faq-arrow {
      color: var(--gold); font-size: 18px; flex-shrink: 0;
      transition: transform 0.25s;
    }
    .faq-item.open .faq-arrow { transform: rotate(45deg); }
    .faq-a {
      max-height: 0; overflow: hidden;
      transition: max-height 0.3s ease, padding 0.3s ease;
      font-size: 14px; color: var(--mist); line-height: 1.7;
      padding: 0 24px;
    }
    .faq-item.open .faq-a { max-height: 300px; padding: 0 24px 20px; }

    /* ── FINAL CTA ── */
    .cta-section {
      padding: 100px 0; text-align: center;
    }
    .cta-box {
      background: linear-gradient(135deg, var(--deep) 0%, var(--slate) 100%);
      border: 1px solid var(--border);
      border-radius: 24px; padding: 72px 40px;
      position: relative; overflow: hidden;
    }
    .cta-box::before {
      content: ''; position: absolute;
      top: -60px; right: -60px;
      width: 300px; height: 300px;
      background: radial-gradient(circle, rgba(201,169,110,0.1) 0%, transparent 70%);
      pointer-events: none;
    }
    .cta-box h2 {
      font-family: 'Syne', sans-serif; font-weight: 800;
      font-size: clamp(28px, 4vw, 44px); color: var(--white);
      margin-bottom: 16px; line-height: 1.15;
    }
    .cta-box p { font-size: 17px; color: var(--mist); margin-bottom: 36px; }
    .cta-guarantee { margin-top: 18px; font-size: 13px; color: var(--mist-d); }

    /* ── FOOTER ── */
    footer {
      border-top: 1px solid var(--border); padding: 40px 0;
      color: var(--mist-d); font-size: 13px;
    }
    .footer-inner {
      max-width: 1100px; margin: 0 auto; padding: 0 24px;
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 16px;
    }
    .footer-logo {
      font-family: 'Syne', sans-serif; font-weight: 800;
      letter-spacing: 1.5px; font-size: 15px; color: var(--mist);
    }
    .footer-links { display: flex; gap: 20px; }
    .footer-links a { color: var(--mist-d); text-decoration: none; transition: color 0.2s; }
    .footer-links a:hover { color: var(--gold); }
  </style>
</head>
<body>

<!-- ── NAV ── -->
<nav>
  <div class="nav-inner">
    <a href="/brokers" class="nav-logo">
      <img src="/barnes-logo.png" alt="Barnes Yachting" onerror="this.style.display='none'">
      BARNESOS
    </a>
    <div class="nav-links">
      <a href="#how-it-works" class="nav-link">How It Works</a>
      <a href="#features" class="nav-link">Features</a>
      <a href="#pricing" class="nav-link">Pricing</a>
      <a href="#faq" class="nav-link">FAQ</a>
      <a href="/broker/login" class="nav-link">Sign In</a>
      <a href="/broker/signup" class="nav-cta">Start Free Trial</a>
    </div>
  </div>
</nav>

<!-- ── HERO ── -->
<section class="hero">
  <div class="container">
    <div class="hero-badge">Signal Radar — Now Available</div>
    <h1>Know When Your Clients<br>Are <em>Ready to Buy</em></h1>
    <p class="hero-sub">
      Upload your prospect list. We scan daily for UHNWI buying signals — yacht inquiries, wealth movement, lifestyle triggers. You get the alert. You make the call.
    </p>
    <div class="hero-ctas">
      <a href="/broker/signup" class="btn-primary">
        Start Your Free Trial <span>→</span>
      </a>
      <a href="#how-it-works" class="btn-secondary">See How It Works</a>
    </div>
    <p class="hero-note">14-day free trial · €100/month after · Cancel anytime</p>
  </div>
</section>

<!-- ── STATS BAR ── -->
<div class="stats-bar">
  <div class="stats-inner">
    <div class="stat-item">
      <span class="stat-num">40+</span>
      <div class="stat-label">Years of Barnes Yachting Heritage</div>
    </div>
    <div class="stat-item">
      <span class="stat-num">Daily</span>
      <div class="stat-label">Automated Signal Scans</div>
    </div>
    <div class="stat-item">
      <span class="stat-num">3-Tier</span>
      <div class="stat-label">Signal Scoring System</div>
    </div>
    <div class="stat-item">
      <span class="stat-num">100%</span>
      <div class="stat-label">Data Encrypted &amp; Isolated</div>
    </div>
  </div>
</div>

<!-- ── HOW IT WORKS ── -->
<section class="how-section" id="how-it-works">
  <div class="container">
    <div class="how-header">
      <p class="section-label">The Process</p>
      <h2 class="section-title">Three Steps to Every Sale</h2>
      <p class="section-sub">No manual research. No missed opportunities. Signal Radar works while you sleep.</p>
    </div>
    <div class="how-grid">
      <div class="how-step">
        <span class="step-num">01</span>
        <div class="step-icon">📋</div>
        <div class="step-title">Upload Your Prospect List</div>
        <p class="step-desc">Import your existing prospect CSV — names, companies, emails. Your data stays in your encrypted workspace. Nobody else sees it.</p>
        <div class="step-arrow">→</div>
      </div>
      <div class="how-step">
        <span class="step-num">02</span>
        <div class="step-icon">🔍</div>
        <div class="step-title">We Scan for Buying Signals</div>
        <p class="step-desc">Every 24 hours, Signal Radar monitors press, financial news, yacht listings, and wealth indicators tied to your prospects. Time-decay scoring keeps signals fresh.</p>
        <div class="step-arrow">→</div>
      </div>
      <div class="how-step">
        <span class="step-num">03</span>
        <div class="step-icon">🎯</div>
        <div class="step-title">Get Alerts When Intent Is High</div>
        <p class="step-desc">When a prospect hits a high-intent threshold — you get notified with context, score, and a recommended action. Call at exactly the right moment.</p>
      </div>
    </div>
  </div>
</section>

<!-- ── DIFFERENTIATOR ── -->
<section style="padding: 20px 0 80px;">
  <div class="diff-section">
    <div class="diff-inner">
      <div class="diff-grid">
        <div>
          <div class="diff-tag">Industry First</div>
          <h2 class="section-title">The Only Yacht Brokerage Tool with Automated UHNWI Buying Signal Detection</h2>
          <p style="font-size:16px;color:var(--mist);line-height:1.65;margin-top:16px;">
            Traditional CRMs tell you what happened. Signal Radar tells you what's about to happen. Built on 40 years of Barnes Yachting deal intelligence.
          </p>
          <div class="diff-list">
            <div class="diff-item">
              <div class="diff-check">✓</div>
              <div class="diff-text"><strong>Time-decay scoring</strong> — signals age out so you chase current intent, not stale data</div>
            </div>
            <div class="diff-item">
              <div class="diff-check">✓</div>
              <div class="diff-text"><strong>3-tier classification</strong> — Hot (act now), Warm (nurture), Cold (monitor)</div>
            </div>
            <div class="diff-item">
              <div class="diff-check">✓</div>
              <div class="diff-text"><strong>White-label dashboard</strong> — present it to clients as your own intelligence platform</div>
            </div>
            <div class="diff-item">
              <div class="diff-check">✓</div>
              <div class="diff-text"><strong>Full data isolation</strong> — your prospect list is encrypted and never shared across tenants</div>
            </div>
          </div>
        </div>
        <div>
          <!-- Signal card mock -->
          <div class="signal-card">
            <div class="signal-header">
              <span class="signal-title">Signal Radar — Today's Alerts</span>
              <span class="signal-badge">LIVE</span>
            </div>
            <div class="signal-row">
              <div class="signal-avatar">VR</div>
              <div style="flex:1">
                <div class="signal-name">Viktor R.</div>
                <div class="signal-reason">🔥 Monaco property acquisition + Yacht Week inquiry detected</div>
              </div>
              <div class="signal-score">
                <div class="score-dots">
                  <div class="dot hot"></div><div class="dot hot"></div><div class="dot hot"></div>
                </div>
                <div class="score-label hot">HOT</div>
              </div>
            </div>
            <div class="signal-row">
              <div class="signal-avatar">AC</div>
              <div style="flex:1">
                <div class="signal-name">Alexandra C.</div>
                <div class="signal-reason">🟡 Wealth fund exit reported in FT, past buyer</div>
              </div>
              <div class="signal-score">
                <div class="score-dots">
                  <div class="dot hot"></div><div class="dot warm"></div><div class="dot cold"></div>
                </div>
                <div class="score-label warm">WARM</div>
              </div>
            </div>
            <div class="signal-row">
              <div class="signal-avatar">MB</div>
              <div style="flex:1">
                <div class="signal-name">Marcus B.</div>
                <div class="signal-reason">📰 IPO announcement — net worth est. +€340M</div>
              </div>
              <div class="signal-score">
                <div class="score-dots">
                  <div class="dot hot"></div><div class="dot hot"></div><div class="dot warm"></div>
                </div>
                <div class="score-label hot">HOT</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ── FEATURES ── -->
<section class="features-section" id="features">
  <div class="container">
    <div class="features-header">
      <p class="section-label">Platform Features</p>
      <h2 class="section-title">Everything a Modern Broker Needs</h2>
      <p class="section-sub">Signal Radar is the centrepiece. The rest of the platform handles your day-to-day.</p>
    </div>
    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-icon">📡</div>
        <div class="feature-title">Signal Radar</div>
        <p class="feature-desc">Daily automated scans. Press, financial news, public wealth indicators and lifestyle triggers matched to your prospect list.</p>
        <span class="feature-highlight">Daily scans · 3-tier scoring · Time decay</span>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🏷️</div>
        <div class="feature-title">White-Label Dashboard</div>
        <p class="feature-desc">Present your intelligence platform under your own brokerage brand. Custom colour and name. Client-facing or internal.</p>
        <span class="feature-highlight">Your brand · Your domain</span>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🔒</div>
        <div class="feature-title">Encrypted Data Isolation</div>
        <p class="feature-desc">Each brokerage is a fully isolated tenant. Your prospect data is AES-256 encrypted at rest. Never shared. Never scraped.</p>
        <span class="feature-highlight">Zero data sharing · Full encryption</span>
      </div>
      <div class="feature-card">
        <div class="feature-icon">👥</div>
        <div class="feature-title">Team Workspace</div>
        <p class="feature-desc">Invite your team. Role-based access (broker / admin). Each member sees the same live signals and shared notes.</p>
        <span class="feature-highlight">Unlimited team members</span>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🛥️</div>
        <div class="feature-title">Yacht Inventory Integration</div>
        <p class="feature-desc">Match hot prospects to your current listings automatically. Signal Radar suggests which yacht to pitch based on profile.</p>
        <span class="feature-highlight">Smart matching</span>
      </div>
      <div class="feature-card">
        <div class="feature-icon">📊</div>
        <div class="feature-title">Analytics & Reporting</div>
        <p class="feature-desc">Track pipeline velocity, signal-to-close rates, and outreach effectiveness. Built-in reports, no spreadsheets needed.</p>
        <span class="feature-highlight">Pipeline visibility</span>
      </div>
    </div>
  </div>
</section>

<!-- ── PRICING ── -->
<section class="pricing-section" id="pricing">
  <div class="container">
    <p class="section-label" style="text-align:center">Pricing</p>
    <h2 class="section-title">Simple, Transparent Pricing</h2>
    <p class="section-sub" style="margin:14px auto 0;text-align:center">One plan. Full access. Cancel any time.</p>

    <div class="pricing-card">
      <div class="pricing-popular">Most Popular</div>
      <div style="margin-bottom:8px">
        <span class="price-amount"><span class="price-currency">€</span>100</span>
      </div>
      <div class="price-period">per brokerage / month</div>

      <ul class="price-features">
        <li><span class="price-check">✓</span> Signal Radar — daily automated scans</li>
        <li><span class="price-check">✓</span> Unlimited prospect uploads</li>
        <li><span class="price-check">✓</span> 3-tier signal scoring with time decay</li>
        <li><span class="price-check">✓</span> Unlimited team members</li>
        <li><span class="price-check">✓</span> White-label dashboard</li>
        <li><span class="price-check">✓</span> Full data encryption &amp; isolation</li>
        <li><span class="price-check">✓</span> Yacht inventory integration</li>
        <li><span class="price-check">✓</span> Priority support</li>
      </ul>

      <a href="/broker/signup" class="btn-primary" style="width:100%;justify-content:center;font-size:16px;padding:16px">
        Start Your 14-Day Free Trial
      </a>
      <div class="pricing-note">No setup fees · No credit card required to start · Cancel anytime</div>
    </div>
  </div>
</section>

<!-- ── TRUST ── -->
<section class="trust-section">
  <div class="container">
    <div style="text-align:center">
      <p class="section-label">Why Trust Us</p>
      <h2 class="section-title">Built on 40 Years of Deal Intelligence</h2>
    </div>
    <div class="trust-grid">
      <div class="trust-card">
        <div class="trust-icon">⚓</div>
        <div class="trust-title">Barnes Yachting Heritage</div>
        <p class="trust-desc">Founded on 40 years of UHNWI yacht brokerage. We built this for the brokers who trained us.</p>
      </div>
      <div class="trust-card">
        <div class="trust-icon">🔐</div>
        <div class="trust-title">Data Privacy Guarantee</div>
        <p class="trust-desc">Your prospect list is yours. AES-256 encryption, zero cross-tenant data access, GDPR compliant architecture.</p>
      </div>
      <div class="trust-card">
        <div class="trust-icon">🏛️</div>
        <div class="trust-title">Institutional Grade</div>
        <p class="trust-desc">Designed for brokerage firms, not startups. Multi-user, role-based access, and an audit trail on every action.</p>
      </div>
      <div class="trust-card">
        <div class="trust-icon">🌍</div>
        <div class="trust-title">Global Coverage</div>
        <p class="trust-desc">Scans English, French, Italian and Arabic press. Signal Radar covers the markets where UHNWI buyers operate.</p>
      </div>
    </div>
  </div>
</section>

<!-- ── FAQ ── -->
<section class="faq-section" id="faq">
  <div class="container">
    <div class="faq-header">
      <p class="section-label">FAQ</p>
      <h2 class="section-title">Common Questions</h2>
    </div>
    <div class="faq-list">
      <div class="faq-item">
        <div class="faq-q">What sources does Signal Radar scan? <span class="faq-arrow">+</span></div>
        <div class="faq-a">Signal Radar monitors financial press, luxury lifestyle publications, public wealth disclosures, yacht event registrations, and brokerage listing activity. We do not scrape private communications or violate any platform terms of service. All data sources are publicly accessible.</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">How does the 3-tier scoring work? <span class="faq-arrow">+</span></div>
        <div class="faq-a">Each signal is scored based on recency, source credibility, and wealth indicator strength. Scores decay over time — a signal from 3 days ago weighs less than today's. Hot (act immediately), Warm (nurture this week), Cold (monitor quarterly). You control the thresholds.</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">Is my prospect list shared with other brokers? <span class="faq-arrow">+</span></div>
        <div class="faq-a">Never. Each brokerage is a fully isolated tenant. Your data is encrypted at rest with AES-256 and is inaccessible to any other tenant or Barnes staff without your consent. We are not a data broker — your list is a competitive asset and we treat it as such.</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">What happens after the 14-day trial? <span class="faq-arrow">+</span></div>
        <div class="faq-a">After the trial, you choose to subscribe at €100/month. Your data and prospect list are preserved whether you subscribe or not. We will email you a reminder 3 days before the trial ends. No credit card required to start the trial.</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">Can I invite my whole team? <span class="faq-arrow">+</span></div>
        <div class="faq-a">Yes. Unlimited team members are included in the €100/month plan. Each member gets their own login with role-based access (Broker or Admin). Admins can manage billing, invite new members, and configure settings. Brokers see all signals and prospect data.</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">Does this work for independent brokers or only large firms? <span class="faq-arrow">+</span></div>
        <div class="faq-a">Both. Signal Radar is priced per brokerage, not per seat. A solo broker pays the same as a 20-person firm. The white-label feature is particularly valuable for firms presenting intelligence to clients, but solo brokers benefit equally from the daily alerts.</div>
      </div>
    </div>
  </div>
</section>

<!-- ── FINAL CTA ── -->
<section class="cta-section">
  <div class="container">
    <div class="cta-box">
      <p class="section-label">Get Started Today</p>
      <h2>Stop Guessing. Start Knowing.</h2>
      <p>Your next deal is in your existing prospect list. Signal Radar finds it.</p>
      <a href="/broker/signup" class="btn-primary" style="font-size:17px;padding:16px 40px">
        Start Your Free Trial — €100/mo after
      </a>
      <p class="cta-guarantee">14 days free · No credit card · Cancel anytime</p>
    </div>
  </div>
</section>

<!-- ── FOOTER ── -->
<footer>
  <div class="footer-inner">
    <div class="footer-logo">BARNESOS</div>
    <div style="font-size:12px;color:var(--mist-d)">
      Powered by Barnes Yachting · 40 years of UHNWI deal intelligence
    </div>
    <div class="footer-links">
      <a href="/broker/login">Broker Sign In</a>
      <a href="/broker/signup">Sign Up</a>
      <a href="#faq">FAQ</a>
    </div>
  </div>
</footer>

<script>
  // FAQ accordion
  document.querySelectorAll('.faq-q').forEach(q => {
    q.addEventListener('click', () => {
      const item = q.parentElement;
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  // Smooth nav offset for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) {
        e.preventDefault();
        const offset = 72;
        const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    });
  });
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(port, () => {
  console.log(`BarnesOS Command Center running on port ${port}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY SCAN SCHEDULER
// Runs every hour. For each tenant with scan_enabled=true and last scan
// older than the configured frequency (daily=24h, weekly=168h), triggers
// a full prospect scan in the background.
// ═══════════════════════════════════════════════════════════════════════════════
async function runDailyScansForDueTenants() {
  try {
    const { rows: tenants } = await pool.query(`
      SELECT id, name, scan_frequency, last_daily_scan_at
      FROM tenants
      WHERE scan_enabled = TRUE
        AND billing_status IN ('active', 'trial')
        AND (
          last_daily_scan_at IS NULL
          OR (
            scan_frequency = 'daily'   AND last_daily_scan_at < NOW() - INTERVAL '24 hours'
          )
          OR (
            scan_frequency = 'weekly'  AND last_daily_scan_at < NOW() - INTERVAL '7 days'
          )
        )
    `);

    if (!tenants.length) {
      console.log('[DailyScan] Cron check — no tenants due for scanning');
      return;
    }

    console.log(`[DailyScan] ${tenants.length} tenant(s) due for scheduled scan`);

    for (const tenant of tenants) {
      console.log(`[DailyScan] Starting scan for tenant: ${tenant.name} (id=${tenant.id})`);

      // Mark scan as started to prevent double-trigger
      await pool.query(`UPDATE tenants SET last_daily_scan_at = NOW() WHERE id = $1`, [tenant.id]);

      const { rows: prospects } = await pool.query(`
        SELECT * FROM prospects
        WHERE tenant_id = $1
        ORDER BY
          CASE heat_tier WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 ELSE 3 END,
          last_scanned_at ASC NULLS FIRST
        LIMIT 50
      `, [tenant.id]);

      if (!prospects.length) {
        console.log(`[DailyScan] Tenant ${tenant.id} has no prospects — skipping`);
        continue;
      }

      // Fire and forget with stagger — don't block the scheduler loop
      (async () => {
        let totalSignals = 0;
        for (const prospect of prospects) {
          try {
            const result = await scanProspect(prospect, 'scheduled');
            totalSignals += result.signals_found;
            await new Promise(r => setTimeout(r, 3000)); // 3s gap between prospects
          } catch (e) {
            console.error(`[DailyScan] Error scanning ${prospect.name} (tenant ${tenant.id}):`, e.message);
          }
        }
        console.log(`[DailyScan] Tenant ${tenant.id} done. ${prospects.length} prospects scanned, ${totalSignals} new signals.`);
      })();
    }
  } catch (err) {
    console.error('[DailyScan] Scheduler error:', err.message);
  }
}

// Run every hour at :05 to avoid on-the-hour traffic spikes
cron.schedule('5 * * * *', () => {
  console.log('[DailyScan] Hourly check triggered by cron');
  runDailyScansForDueTenants();
}, { timezone: 'UTC' });

console.log('[DailyScan] Scheduler initialized — checks every hour for due tenant scans');


// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY CSV IMPORT
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CSV/TSV Parser ───────────────────────────────────────────────────────────
function splitCSVLine(line, delimiter) {
  if (delimiter === '\t') return line.split('\t').map(v => v.trim());
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += line[i];
    }
  }
  result.push(current.trim());
  return result;
}

function parsePrice(str) {
  if (!str) return null;
  // Remove currency symbols, spaces → "35 500 000" → 35500000
  const cleaned = str.replace(/[€$£\s]/g, '').replace(/,/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

function parseLength(str) {
  if (!str) return null;
  // "52,4" → 52.4, "27.0" → 27.0
  const cleaned = str.replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

function parsePercent(str) {
  if (!str) return 0;
  const val = parseFloat(str.replace('%', '').trim());
  return isNaN(val) ? 0 : val;
}

function normalizeHeader(h) {
  return h.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseYachtCSV(text) {
  // Normalize line endings and remove BOM
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  if (lines.length < 2) {
    return { rows: [], errors: ['File must have a header row and at least one data row'] };
  }

  // Detect delimiter: prefer tab, then semicolon, then comma
  const firstLine = lines[0];
  const tabCount   = (firstLine.match(/\t/g) || []).length;
  const semiCount  = (firstLine.match(/;/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delimiter  = tabCount > 0 ? '\t' : semiCount > commaCount ? ';' : ',';

  const rawHeaders = splitCSVLine(lines[0], delimiter);
  const headers = rawHeaders.map(normalizeHeader);

  // Flexible column mapping for the NEW 12-field CSV structure
  // Key: DB field name → array of possible normalized header aliases (first match wins)
  const colAliases = {
    // The 12 priority fields
    is_active:     ['active_', 'active', 'is_active', 'actif'],
    is_approved:   ['approved_', 'approved', 'is_approved', 'approuv'],
    brokers:       ['_brokers', 'brokers', 'broker', 'agent', 'courtier'],
    builder:       ['builder_os', 'builder', 'shipyard', 'chantier', 'constructeur', 'brand'],
    currency:      ['currency', 'devise', 'curr'],
    length:        ['length', 'length_m', 'lenght', 'loa', 'loa_m', 'taille', 'metres'],
    lob:           ['lob', 'lob_m', 'lhb', 'beam'],
    location_text: ['location_text', 'location', 'loc', 'port', 'country', 'lieu', 'position'],
    price:         ['price', 'prix', 'price_eur', 'asking_price', 'list_price', 'valeur'],
    name:          ['name', 'nom', 'yacht_name', 'vessel_name', 'model', 'modele'],
    year_refit:    ['year_refit', 'refit_year', 'refit', 'year_of_refit', 'annee_refit'],
    year_built:    ['yearbuilt', 'year_built', 'build_year', 'annee_construction', 'built', 'year'],
  };

  const colIdx = {};
  for (const [field, aliases] of Object.entries(colAliases)) {
    for (const alias of aliases) {
      const idx = headers.indexOf(alias);
      if (idx !== -1) { colIdx[field] = idx; break; }
    }
  }

  // Track which column indices are mapped to known fields
  const mappedIndices = new Set(Object.values(colIdx));

  const rows = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i], delimiter);
    if (cols.every(c => !c.trim())) continue; // skip blank rows

    const get = (field) => {
      const idx = colIdx[field];
      return idx !== undefined && idx < cols.length ? (cols[idx] || '').trim() : '';
    };

    const name = get('name');
    const builder = get('builder');

    if (!name && !builder) {
      errors.push(`Row ${i + 1}: Missing name and builder — skipped`);
      continue;
    }

    // Parse price
    const priceRaw = get('price');
    const price = parsePrice(priceRaw);

    // Parse lengths
    const length = parseLength(get('length'));
    const lob = parseLength(get('lob'));

    // Parse years
    const parseYear = (s) => {
      if (!s) return null;
      const y = parseInt(s.replace(/[^0-9]/g, ''), 10);
      return y > 1900 && y < 2100 ? y : null;
    };
    const yearBuilt  = parseYear(get('year_built'));
    const yearRefit  = parseYear(get('year_refit'));

    // Parse boolean fields — handles checkmarks, yes/no, true/false, x/✓/✅
    const parseBool = (s, defaultVal = true) => {
      if (!s) return defaultVal;
      const lower = s.toLowerCase().trim();
      if (['false', '0', 'no', 'non', 'n', '', '-'].includes(lower)) return false;
      // Any truthy value: yes, true, 1, x, ✓, ✅, checked
      return true;
    };

    const isActive   = parseBool(get('is_active'), true);
    const isApproved = parseBool(get('is_approved'), false);

    // Parse currency
    let currency = get('currency') || null;
    if (!currency && priceRaw) {
      // Try to detect from price string
      if (priceRaw.includes('€') || priceRaw.toUpperCase().includes('EUR')) currency = 'EUR';
      else if (priceRaw.includes('$') || priceRaw.toUpperCase().includes('USD')) currency = 'USD';
      else if (priceRaw.includes('£') || priceRaw.toUpperCase().includes('GBP')) currency = 'GBP';
    }

    // Collect extra columns not in the known mapping into JSONB
    const extraData = {};
    for (let ci = 0; ci < rawHeaders.length; ci++) {
      if (!mappedIndices.has(ci) && rawHeaders[ci] && cols[ci] && cols[ci].trim()) {
        extraData[rawHeaders[ci].trim()] = cols[ci].trim();
      }
    }

    rows.push({
      name:          name || null,
      builder:       builder || null,
      length,
      lob,
      year_built:    yearBuilt,
      year_refit:    yearRefit,
      price,
      currency,
      location_text: get('location_text') || null,
      is_active:     isActive,
      is_approved:   isApproved,
      brokers:       get('brokers') || null,
      extra_data:    Object.keys(extraData).length > 0 ? extraData : null,
    });
  }

  return { rows, errors };
}

// ─── Ensure import_jobs table ─────────────────────────────────────────────────
async function ensureImportJobsTable() {
  await pool.query(`
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
}
ensureImportJobsTable().catch(err => console.error('Failed to ensure import_jobs table:', err.message));

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE SHEET AUTO-SYNC
// Daily full-replace of yacht inventory from the published Google Sheet.
// Sheet: https://docs.google.com/spreadsheets/d/1Ayb3TC4-3KXTOoqGOpyvXwq4ihErSdZY
// ═══════════════════════════════════════════════════════════════════════════════

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1Ayb3TC4-3KXTOoqGOpyvXwq4ihErSdZY/export?format=csv&gid=1382914312';

// Ensure sheet_syncs log table exists (idempotent)
async function ensureSheetSyncsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sheet_syncs (
      id              SERIAL PRIMARY KEY,
      status          VARCHAR(20) DEFAULT 'running',
      rows_fetched    INTEGER DEFAULT 0,
      rows_inserted   INTEGER DEFAULT 0,
      error_message   TEXT,
      started_at      TIMESTAMPTZ DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sheet_syncs_started_at ON sheet_syncs(started_at DESC)
  `);
}
ensureSheetSyncsTable().catch(err => console.error('[SheetSync] Failed to ensure sheet_syncs table:', err.message));

// Fetch CSV from Google Sheets, following up to 5 redirects
function fetchSheetCSV(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 5;
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error('Too many redirects fetching sheet'));
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain
        return fetchSheetCSV(res.headers.location, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching sheet`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Sheet fetch timed out after 30s'));
    });
  });
}

// Full sync: fetch → parse → atomic wipe+insert (aborts if fetch/parse fails)
async function syncInventoryFromSheet() {
  const { rows: logRows } = await pool.query(
    `INSERT INTO sheet_syncs (status, started_at) VALUES ('running', NOW()) RETURNING id`
  );
  const syncId = logRows[0].id;
  console.log(`[SheetSync] Starting sync #${syncId}`);

  try {
    // 1. Fetch CSV from Google Sheets
    const csvText = await fetchSheetCSV(SHEET_CSV_URL);
    console.log(`[SheetSync] Fetched ${csvText.length} bytes from sheet`);

    // 2. Parse using existing parser
    const { rows, errors: parseErrors } = parseYachtCSV(csvText);
    console.log(`[SheetSync] Parsed ${rows.length} rows, ${parseErrors.length} parse errors`);

    if (rows.length === 0) {
      throw new Error(
        `Sheet returned 0 valid rows (${parseErrors.length} parse errors). ` +
        `Aborting sync to preserve existing inventory.`
      );
    }

    // 3. Atomic replace in a single transaction — inventory only wiped if insert succeeds
    const client = await pool.connect();
    let insertedCount = 0;
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM yachts');

      for (const row of rows) {
        await client.query(
          `INSERT INTO yachts
             (name, builder, length, lob, year_built, year_refit,
              price, currency, location_text, is_active, is_approved, brokers, extra_data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
          [
            row.name, row.builder, row.length, row.lob,
            row.year_built, row.year_refit, row.price, row.currency,
            row.location_text, row.is_active, row.is_approved, row.brokers,
            row.extra_data ? JSON.stringify(row.extra_data) : '{}'
          ]
        );
        insertedCount++;
      }

      await client.query('COMMIT');
      console.log(`[SheetSync] Sync #${syncId} complete: ${insertedCount} yachts`);
    } catch (dbErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw dbErr;
    } finally {
      client.release();
    }

    // 4. Log success
    await pool.query(
      `UPDATE sheet_syncs
       SET status = 'success', rows_fetched = $1, rows_inserted = $2, completed_at = NOW()
       WHERE id = $3`,
      [rows.length, insertedCount, syncId]
    );
    return { success: true, rows_fetched: rows.length, rows_inserted: insertedCount };

  } catch (err) {
    console.error(`[SheetSync] Sync #${syncId} failed:`, err.message);
    await pool.query(
      `UPDATE sheet_syncs
       SET status = 'failed', error_message = $1, completed_at = NOW()
       WHERE id = $2`,
      [err.message, syncId]
    ).catch(() => {});
    return { success: false, error: err.message };
  }
}

// Daily cron: 03:00 UTC every day
cron.schedule('0 3 * * *', () => {
  console.log('[SheetSync] Daily cron triggered — syncing from Google Sheet');
  syncInventoryFromSheet().catch(err => console.error('[SheetSync] Cron error:', err.message));
}, { timezone: 'UTC' });

console.log('[SheetSync] Daily inventory sync scheduled — 03:00 UTC');

// ─── API: Get inventory stats ─────────────────────────────────────────────────
app.get('/api/inventory/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE is_active = TRUE)   as available,
              COUNT(*) FILTER (WHERE is_approved = TRUE) as approved,
              COALESCE(AVG(price), 0)::numeric(15,2) as avg_price
       FROM yachts`
    );
    res.json({ success: true, stats: { ...rows[0], discounted: rows[0].approved } });
  } catch (err) {
    console.error('Error fetching inventory stats:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ─── API: Get import job status ───────────────────────────────────────────────
app.get('/api/inventory/import/jobs/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM import_jobs WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Job not found' });
    const job = rows[0];
    const progress = job.total_rows > 0
      ? Math.round(((job.inserted_count + job.rejected_count) / job.total_rows) * 100)
      : 0;
    res.json({ success: true, job: { ...job, progress } });
  } catch (err) {
    console.error('Error fetching import job:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch job' });
  }
});

// ─── API: Start CSV import ────────────────────────────────────────────────────
app.post('/api/inventory/import', requireAuth, express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { csv, mode = 'replace' } = req.body;
    if (!csv || typeof csv !== 'string') {
      return res.status(400).json({ success: false, message: 'CSV content is required' });
    }
    if (!['replace', 'merge'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Mode must be "replace" or "merge"' });
    }

    // Parse CSV now (fast, < 1s for 500 rows)
    const { rows, errors: parseErrors } = parseYachtCSV(csv);
    if (rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid rows found in CSV',
        parse_errors: parseErrors.slice(0, 10)
      });
    }

    // Create job record
    const { rows: jobRows } = await pool.query(
      `INSERT INTO import_jobs (status, mode, total_rows, errors)
       VALUES ('processing', $1, $2, $3::jsonb)
       RETURNING id`,
      [mode, rows.length, JSON.stringify(parseErrors.slice(0, 50))]
    );
    const jobId = jobRows[0].id;

    // Respond immediately with job ID
    res.json({ success: true, job_id: jobId, total_rows: rows.length, parse_errors: parseErrors.length });

    // Background processing
    setImmediate(async () => {
      let insertedCount = 0;
      let rejectedCount = parseErrors.length;
      const batchErrors = [...parseErrors.slice(0, 50)];
      const BATCH_SIZE = 50;

      try {
        const client = await pool.connect();
        try {
          // Replace mode: wipe existing inventory
          if (mode === 'replace') {
            await client.query('DELETE FROM yachts');
          }

          // Insert in batches
          for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);
            try {
              await client.query('BEGIN');
              for (const row of batch) {
                await client.query(
                  `INSERT INTO yachts (name, builder, length, lob, year_built, year_refit,
                     price, currency, location_text, is_active, is_approved, brokers, extra_data)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
                  [row.name, row.builder, row.length, row.lob, row.year_built, row.year_refit,
                   row.price, row.currency, row.location_text, row.is_active, row.is_approved,
                   row.brokers, row.extra_data ? JSON.stringify(row.extra_data) : '{}']
                );
                insertedCount++;
              }
              await client.query('COMMIT');
            } catch (batchErr) {
              await client.query('ROLLBACK').catch(() => {});
              rejectedCount += batch.length;
              insertedCount -= batch.length;
              if (insertedCount < 0) insertedCount = 0;
              batchErrors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${batchErr.message}`);
              console.error(`Import batch error:`, batchErr.message);
            }

            // Update progress after each batch
            await pool.query(
              `UPDATE import_jobs SET inserted_count = $1, rejected_count = $2 WHERE id = $3`,
              [insertedCount, rejectedCount, jobId]
            ).catch(() => {});
          }
        } finally {
          client.release();
        }

        // Mark completed
        await pool.query(
          `UPDATE import_jobs SET status = 'completed', inserted_count = $1, rejected_count = $2,
           errors = $3::jsonb, completed_at = NOW() WHERE id = $4`,
          [insertedCount, rejectedCount, JSON.stringify(batchErrors.slice(0, 50)), jobId]
        );
        console.log(`[Import] Job ${jobId} complete: ${insertedCount} inserted, ${rejectedCount} rejected`);

      } catch (err) {
        console.error(`[Import] Job ${jobId} failed:`, err.message);
        await pool.query(
          `UPDATE import_jobs SET status = 'failed', completed_at = NOW(),
           errors = $1::jsonb WHERE id = $2`,
          [JSON.stringify([...batchErrors, `Fatal: ${err.message}`].slice(0, 50)), jobId]
        ).catch(() => {});
      }
    });

  } catch (err) {
    console.error('Error starting import:', err.message);
    res.status(500).json({ success: false, message: 'Failed to start import' });
  }
});

// ─── API: Manual Google Sheet sync trigger ────────────────────────────────────
app.post('/api/inventory/sync-sheet', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, message: 'Sheet sync started. Check /api/inventory/sheet-syncs for status.' });
    setImmediate(() => {
      syncInventoryFromSheet().catch(err => console.error('[SheetSync] Manual trigger error:', err.message));
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── API: Sheet sync history ──────────────────────────────────────────────────
app.get('/api/inventory/sheet-syncs', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status, rows_fetched, rows_inserted, error_message, started_at, completed_at
       FROM sheet_syncs
       ORDER BY started_at DESC
       LIMIT 20`
    );
    res.json({ success: true, syncs: rows });
  } catch (err) {
    console.error('[SheetSync] History error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch sync history' });
  }
});

// ─── API: Broker portal image scraper ────────────────────────────────────────
// Attempts to log in to hub.barnes-yachting.com/broker_portal and scrape
// yacht images, then match them to DB yachts by name/builder.
// Falls back gracefully if the portal requires JS rendering.

app.post('/api/yachts/scrape-images', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, message: 'Image scraping started. Runs in background — refresh inventory in ~30 seconds.' });

    setImmediate(async () => {
      try {
        console.log('[Scraper] Starting broker portal image scrape...');
        const PORTAL_BASE    = 'https://hub.barnes-yachting.com';
        const PORTAL_URL     = `${PORTAL_BASE}/broker_portal`;
        const PORTAL_EMAIL   = 'b.delahaye@barnes-yachting.com';
        const PORTAL_PASS    = 'MR!6P8o$j4FKtDyp';
        const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        let cookies = '';

        // ── 1. Fetch login page to collect any session cookies / CSRF token ──
        const loginPageResp = await fetch(`${PORTAL_URL}?view=fleet`, { headers: { 'User-Agent': UA }, redirect: 'follow' }).catch(() => null);
        if (loginPageResp) {
          const sc = loginPageResp.headers.get('set-cookie');
          if (sc) cookies = sc.split(',').map(c => c.split(';')[0].trim()).join('; ');
          const html = await loginPageResp.text().catch(() => '');
          const m = html.match(/name=["'](?:_token|csrf_token|csrfmiddlewaretoken)["'][^>]*value=["']([^"']+)["']/i)
                 || html.match(/value=["']([^"']{30,})["'][^>]*name=["'](?:_token|csrf)[^"']*["']/i);
          const csrf = m ? m[1] : '';

          // ── 2. Attempt login POST ───────────────────────────────────────────
          for (const ep of [`${PORTAL_BASE}/login`, `${PORTAL_BASE}/auth/login`, `${PORTAL_BASE}/broker_portal/login`, `${PORTAL_URL}`]) {
            try {
              const body = new URLSearchParams({ email: PORTAL_EMAIL, password: PORTAL_PASS });
              if (csrf) { body.append('_token', csrf); body.append('csrf_token', csrf); }
              const lr = await fetch(ep, {
                method: 'POST', body: body.toString(), redirect: 'manual',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, 'User-Agent': UA, Referer: PORTAL_URL }
              }).catch(() => null);
              if (lr) {
                const lc = lr.headers.get('set-cookie');
                if (lc) cookies += '; ' + lc.split(',').map(c => c.split(';')[0].trim()).join('; ');
                if ([200,302,301].includes(lr.status)) { console.log(`[Scraper] Login at ${ep}: ${lr.status}`); break; }
              }
            } catch (_) {}
          }
        }

        // ── 3. Fetch fleet page ───────────────────────────────────────────────
        const fleetResp = await fetch(`${PORTAL_URL}?view=fleet`, {
          headers: { Cookie: cookies, 'User-Agent': UA, Accept: 'text/html' }
        }).catch(() => null);

        if (!fleetResp) {
          console.error('[Scraper] Cannot reach portal');
          return;
        }

        const fleetHtml = await fleetResp.text().catch(() => '');
        console.log(`[Scraper] Fleet page: ${fleetHtml.length} chars, status ${fleetResp.status}`);

        // ── 4. Extract image URLs ─────────────────────────────────────────────
        const imgSeen = new Set();
        const images = [];
        const imgRx = /<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>|background(?:-image)?:\s*url\(["']?([^"')]+)["']?\)/gi;
        let m2;
        while ((m2 = imgRx.exec(fleetHtml)) !== null) {
          const raw = m2[1] || m2[3] || '';
          const alt = m2[2] || '';
          if (!raw) continue;
          const src = raw.startsWith('http') ? raw : raw.startsWith('/') ? `${PORTAL_BASE}${raw}` : `${PORTAL_BASE}/${raw}`;
          if (!imgSeen.has(src) && /\.(jpe?g|png|webp)/i.test(src)) {
            imgSeen.add(src);
            images.push({ src, alt });
          }
        }
        console.log(`[Scraper] Found ${images.length} image candidates`);

        if (images.length === 0) {
          console.log('[Scraper] No images extracted — portal likely requires JavaScript to render.');
          console.log('[Scraper] Portal HTML preview:', fleetHtml.substring(0, 800));
          return;
        }

        // ── 5. Match images to DB yachts ──────────────────────────────────────
        const { rows: dbYachts } = await pool.query('SELECT id, name, builder FROM yachts WHERE image_url IS NULL ORDER BY id');
        let updated = 0;
        for (const yacht of dbYachts) {
          const yName = (yacht.name || '').toLowerCase();
          const yBuild = (yacht.builder || '').toLowerCase();
          const best = images.find(img => {
            const a = (img.alt || img.src).toLowerCase();
            const words = yName.split(/\s+/).filter(w => w.length > 4);
            return words.some(w => a.includes(w)) || (yBuild.length > 3 && a.includes(yBuild.substring(0, 6)));
          });
          if (best) {
            await pool.query('UPDATE yachts SET image_url = $1, updated_at = NOW() WHERE id = $2', [best.src, yacht.id]);
            updated++;
            console.log(`[Scraper] Matched image for yacht ${yacht.id}: ${yacht.name}`);
          }
        }
        console.log(`[Scraper] Done. Updated ${updated} of ${dbYachts.length} yachts with images.`);

      } catch (e) {
        console.error('[Scraper] Background error:', e.message);
      }
    });

  } catch (err) {
    console.error('[Scraper] Error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to start scraper' });
  }
});

// ─── API: Set image URL for a single yacht ───────────────────────────────────
app.patch('/api/yachts/:id/image', requireAuth, express.json(), async (req, res) => {
  try {
    const { image_url } = req.body;
    if (!image_url) return res.status(400).json({ success: false, message: 'image_url required' });
    await pool.query('UPDATE yachts SET image_url = $1, updated_at = NOW() WHERE id = $2', [image_url, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── API: Set / clear product URL for a yacht ─────────────────────────────────
app.patch('/api/yachts/:id/product-url', requireAuth, express.json(), async (req, res) => {
  try {
    const { product_url } = req.body;
    // Allow null/empty to clear the URL
    const url = product_url ? product_url.trim() : null;
    await pool.query(
      'UPDATE yachts SET product_url = $1, updated_at = NOW() WHERE id = $2',
      [url, req.params.id]
    );
    res.json({ success: true, product_url: url });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// WHATSAPP PRESS FEED — Signal source from exported WhatsApp chats
// ═══════════════════════════════════════════════════════════════════════════════

// Ensure the press imports table exists (graceful if migration hasn't run yet)
async function ensurePressFeedTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_press_imports (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(500),
      articles_parsed INTEGER DEFAULT 0,
      matches_found INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'completed',
      error_message TEXT,
      imported_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add source_type to prospect_signals if not present
  await pool.query(`
    ALTER TABLE prospect_signals
      ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'web'
  `);
}
ensurePressFeedTable().catch(err => console.error('[PressFeed] Table init error:', err.message));

// Extract all HTTP/HTTPS URLs from a block of text
function extractUrlsFromText(text) {
  const urlRegex = /https?:\/\/[^\s\]>)'"]+/g;
  const raw = text.match(urlRegex) || [];
  return [...new Set(raw.map(u => u.replace(/[.,;!?:)]+$/, '')))];
}

// Parse a WhatsApp exported .txt file into articles (URL + context snippet)
// Handles both iOS: [DD/MM/YYYY, HH:MM:SS] Name: msg
//            and Android: DD/MM/YYYY, HH:MM:SS - Name: msg
function parseWhatsAppExport(content) {
  const lines = content.split(/\r?\n/);
  // Loose pattern: optional [ timestamp ] or timestamp - before "Name: message"
  const linePattern = /^\[?[\d\/\.\-]+,?\s+[\d:]+(?:\s*[APM]+)?\]?\s*[-–]\s*(.+?):\s+(.+)$/i;
  const articles = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const match = line.match(linePattern);
    if (!match) continue;

    const message = match[2] || '';
    const urls = extractUrlsFromText(message);
    if (urls.length === 0) continue;

    // Grab surrounding context (prev line + this line + next 2)
    const contextLines = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3));
    const snippet = contextLines
      .join(' ')
      .replace(/\[?[\d\/\.\-]+,?\s+[\d:]+(?:\s*[APM]+)?\]?\s*[-–]\s*[^:]+:\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 600);

    for (const url of urls) {
      articles.push({ url, snippet });
    }
  }

  // Deduplicate by normalised URL
  const seen = new Set();
  return articles.filter(a => {
    const key = a.url.toLowerCase().split('?')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Match a list of articles against all prospects; returns signal records to insert
async function matchArticlesToProspects(articles, prospects, triggerRules) {
  const matches = [];

  for (const article of articles) {
    const searchText = `${article.snippet} ${article.url}`.toLowerCase();

    for (const prospect of prospects) {
      // Must match all first-name+last-name tokens OR company (≥4 chars)
      const nameTokens = prospect.name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const compTokens = (prospect.company || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);

      const nameHit = nameTokens.length > 0 && nameTokens.every(w => searchText.includes(w));
      const compHit = compTokens.length > 0 && compTokens.some(w => {
        // require exact word boundary match to avoid "Ford" matching "afford"
        const re = new RegExp(`\\b${w}\\b`);
        return re.test(searchText);
      });

      if (!nameHit && !compHit) continue;

      // Score: use trigger rules if any keyword matches, else default 2
      const { rule, baseScore } = matchArticleToRules(
        { title: article.snippet, summary: article.url },
        triggerRules
      );
      const multiplier = getSourceMultiplier('WhatsApp Press Feed', article.url);
      const finalScore = Math.max(1, Math.round((baseScore || 2) * multiplier));

      matches.push({
        prospectId: prospect.id,
        ruleId: rule ? rule.id : null,
        signalType: rule ? rule.category : 'press_mention',
        title: article.snippet.substring(0, 255) || article.url,
        summary: `Mentioned in international press feed. Match: ${nameHit ? prospect.name : prospect.company}`,
        sourceUrl: article.url,
        sourceName: 'WhatsApp Press Feed',
        sourceType: 'whatsapp_press',
        score: finalScore
      });

      // Only one match per article per prospect
      break;
    }
  }

  return matches;
}

// ─── API: Import a WhatsApp press feed export ─────────────────────────────────
app.post('/api/press-feed/import', requireAuth, express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { content, filename } = req.body;
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ success: false, message: 'content (WhatsApp export text) is required' });
    }

    // Parse articles from WhatsApp export
    const articles = parseWhatsAppExport(content);
    if (articles.length === 0) {
      // Record the attempt even if no URLs found
      await pool.query(
        `INSERT INTO whatsapp_press_imports (filename, articles_parsed, matches_found, status, error_message)
         VALUES ($1, 0, 0, 'no_urls', 'No URLs found in export')`,
        [filename || 'unknown.txt']
      );
      return res.json({
        success: true,
        articles_parsed: 0,
        matches_found: 0,
        signals_created: 0,
        message: 'No URLs found in the export file.'
      });
    }

    // Fetch all prospects + active trigger rules
    const { rows: prospects } = await pool.query(
      'SELECT id, name, company, heat_tier FROM prospects WHERE name IS NOT NULL ORDER BY heat_score DESC'
    );
    const { rows: triggerRules } = await pool.query(
      'SELECT * FROM trigger_rules WHERE is_active = TRUE'
    );

    // Match articles to prospects
    const matches = await matchArticlesToProspects(articles, prospects, triggerRules);

    // Dedup: skip if same source_url already stored for this prospect (any time)
    const { rows: existingSignals } = await pool.query(
      `SELECT prospect_id, source_url FROM prospect_signals
       WHERE source_name = 'WhatsApp Press Feed' AND source_url IS NOT NULL`
    );
    const existingKeys = new Set(
      existingSignals.map(s => `${s.prospect_id}::${(s.source_url || '').split('?')[0].toLowerCase()}`)
    );

    let signalsCreated = 0;
    const prospectIdsToRecalc = new Set();

    for (const m of matches) {
      const dedupKey = `${m.prospectId}::${(m.sourceUrl || '').split('?')[0].toLowerCase()}`;
      if (existingKeys.has(dedupKey)) continue;
      existingKeys.add(dedupKey);

      await pool.query(
        `INSERT INTO prospect_signals
           (prospect_id, trigger_rule_id, signal_type, title, summary, source_url, source_name, source_type, score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [m.prospectId, m.ruleId, m.signalType, m.title, m.summary,
         m.sourceUrl, m.sourceName, m.sourceType, m.score]
      );
      signalsCreated++;
      prospectIdsToRecalc.add(m.prospectId);
    }

    // Recalculate heat for all matched prospects
    for (const pid of prospectIdsToRecalc) {
      await recalcProspectHeat(pid);
    }

    // Record import run
    const { rows: importRows } = await pool.query(
      `INSERT INTO whatsapp_press_imports (filename, articles_parsed, matches_found, status)
       VALUES ($1, $2, $3, 'completed') RETURNING id, imported_at`,
      [filename || 'export.txt', articles.length, signalsCreated]
    );

    console.log(`[PressFeed] Import complete: ${articles.length} articles, ${signalsCreated} signals created, ${prospectIdsToRecalc.size} prospects updated`);

    res.json({
      success: true,
      import_id: importRows[0].id,
      imported_at: importRows[0].imported_at,
      articles_parsed: articles.length,
      matches_found: matches.length,
      signals_created: signalsCreated,
      prospects_updated: prospectIdsToRecalc.size,
      message: `Parsed ${articles.length} articles, created ${signalsCreated} new signal${signalsCreated !== 1 ? 's' : ''} across ${prospectIdsToRecalc.size} prospect${prospectIdsToRecalc.size !== 1 ? 's' : ''}.`
    });
  } catch (err) {
    console.error('[PressFeed] Import error:', err.message);
    // Try to record failed import
    try {
      await pool.query(
        `INSERT INTO whatsapp_press_imports (filename, status, error_message) VALUES ($1, 'failed', $2)`,
        [req.body?.filename || 'unknown.txt', err.message]
      );
    } catch (_) { /* ignore */ }
    res.status(500).json({ success: false, message: 'Import failed: ' + err.message });
  }
});

// ─── API: Press feed import history ──────────────────────────────────────────
app.get('/api/press-feed/imports', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, filename, articles_parsed, matches_found, status, error_message, imported_at
       FROM whatsapp_press_imports
       ORDER BY imported_at DESC
       LIMIT 20`
    );

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*) as total_imports,
              COALESCE(SUM(articles_parsed), 0) as total_articles,
              COALESCE(SUM(matches_found), 0) as total_signals,
              MAX(imported_at) as last_import_at
       FROM whatsapp_press_imports
       WHERE status = 'completed'`
    );

    res.json({
      success: true,
      imports: rows,
      stats: totalRows[0]
    });
  } catch (err) {
    console.error('[PressFeed] History error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch import history' });
  }
});

