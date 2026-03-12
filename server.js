const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

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
  return res.redirect('/login');
}

// Block unauthenticated access to HTML pages and root
// (Runs before express.static to intercept static file serving)
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/login.html') return next();
  if (req.path.startsWith('/api/') || req.path === '/health') return next();
  // Block root (express.static would serve public/index.html) and .html files
  if (req.path === '/' || req.path.endsWith('.html')) {
    if (!req.session || !req.session.authenticated) {
      return res.redirect('/login');
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

// ─── API AUTH GUARD ───────────────────────────────────────────────────────────
// Protect all /api routes except auth endpoints
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (!req.session || !req.session.authenticated) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
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
        }
      } else if (bMax !== Infinity && price > bMax) {
        const diff = (price - bMax) / bMax;
        if (diff < 0.3) {
          score += Math.round(40 * (1 - diff));
          reasons.push('Slightly above budget');
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

    // Signals today
    const { rows: signalsToday } = await pool.query(`
      SELECT COUNT(*) as count FROM prospect_signals
      WHERE detected_at >= CURRENT_DATE
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
        signals_today: parseInt(signalsToday[0].count),
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
    const { rows: prospects } = await pool.query(
      'SELECT * FROM prospects ORDER BY last_scanned_at ASC NULLS FIRST LIMIT 50'
    );
    const results = { scanned: 0, signals_found: 0, errors: 0 };

    for (const prospect of prospects) {
      try {
        const result = await scanProspect(prospect);
        results.scanned++;
        results.signals_found += result.signals_found;
      } catch (err) {
        results.errors++;
        console.error(`Scan error for ${prospect.name}:`, err.message);
      }
    }

    res.json({ success: true, ...results });
  } catch (err) {
    console.error('Error in bulk scan:', err.message);
    res.status(500).json({ success: false, message: 'Failed to run bulk scan' });
  }
});

// ─── Signal Scanner Engine ───────────────────────────────────────────────────
async function scanProspect(prospect) {
  const scanStart = new Date();
  let signalsFound = 0;

  try {
    // Get active trigger rules
    const { rows: rules } = await pool.query(
      'SELECT * FROM trigger_rules WHERE is_active = TRUE'
    );

    // Build search queries for this prospect
    const searchQueries = [
      `"${prospect.name}" news`,
      `"${prospect.name}" ${prospect.company || ''} business`,
      `"${prospect.name}" yacht OR boat OR marine`,
    ];

    // For each query, simulate signal detection
    // In production, this would use Google News API, Brave Search, or web scraping
    // For now, we use keyword matching against the prospect's existing data + generate demo signals
    for (const rule of rules) {
      const keywords = rule.keywords || [];
      const matchedKeywords = [];

      // Check if any keywords match the prospect's notes or interests
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        const searchText = `${prospect.notes || ''} ${prospect.current_yacht_interest || ''} ${prospect.company || ''}`.toLowerCase();
        if (searchText.includes(kwLower)) {
          matchedKeywords.push(kw);
        }
      }

      if (matchedKeywords.length > 0) {
        // Check if we already have a recent signal of this type
        const { rows: existing } = await pool.query(
          `SELECT id FROM prospect_signals
           WHERE prospect_id = $1 AND trigger_rule_id = $2
           AND detected_at > NOW() - INTERVAL '7 days'`,
          [prospect.id, rule.id]
        );

        if (existing.length === 0) {
          // Create new signal
          await pool.query(
            `INSERT INTO prospect_signals (prospect_id, trigger_rule_id, signal_type, title, summary, source_name, score)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              prospect.id,
              rule.id,
              rule.category,
              `${rule.name}: ${prospect.name}`,
              `Keywords matched: ${matchedKeywords.join(', ')}. Source: prospect profile analysis.`,
              'Profile Scan',
              rule.score_weight
            ]
          );
          signalsFound++;
        }
      }
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
      `INSERT INTO scan_history (prospect_id, scan_type, signals_found, search_queries, status, completed_at)
       VALUES ($1, 'manual', $2, $3, 'completed', NOW())`,
      [prospect.id, signalsFound, searchQueries]
    );

    return { prospect_id: prospect.id, prospect_name: prospect.name, signals_found: signalsFound };
  } catch (err) {
    // Log failed scan
    await pool.query(
      `INSERT INTO scan_history (prospect_id, scan_type, signals_found, status, error_message, completed_at)
       VALUES ($1, 'manual', 0, 'failed', $2, NOW())`,
      [prospect.id, err.message]
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
    // Sum scores from recent signals (last 90 days)
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(score), 0) as total_score
       FROM prospect_signals
       WHERE prospect_id = $1 AND detected_at > NOW() - INTERVAL '90 days'`,
      [prospectId]
    );

    const totalScore = parseInt(rows[0].total_score);
    let tier = 'cold';
    if (totalScore >= 10) tier = 'hot';
    else if (totalScore >= 4) tier = 'warm';

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
app.get('/', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.type('html').sendFile(htmlPath);
  } else {
    res.json({ message: 'BarnesOS Yacht Matchmaker' });
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

app.listen(port, () => {
  console.log(`BarnesOS Command Center running on port ${port}`);
});


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

