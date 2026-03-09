const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ─── API: Get all available yachts ──────────────────────────────────────────
app.get('/api/yachts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM yachts WHERE is_available = TRUE ORDER BY length_m DESC`
    );
    res.json({ success: true, yachts: rows, count: rows.length });
  } catch (err) {
    console.error('Error fetching yachts:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch yachts' });
  }
});

// ─── API: Get unique filter values ──────────────────────────────────────────
app.get('/api/yachts/filters', async (req, res) => {
  try {
    const brands = await pool.query(
      `SELECT DISTINCT brand FROM yachts WHERE is_available = TRUE ORDER BY brand`
    );
    const locations = await pool.query(
      `SELECT DISTINCT location FROM yachts WHERE is_available = TRUE ORDER BY location`
    );
    const stats = await pool.query(
      `SELECT MIN(price_eur) as min_price, MAX(price_eur) as max_price,
              MIN(length_m) as min_length, MAX(length_m) as max_length,
              COUNT(*) as total
       FROM yachts WHERE is_available = TRUE`
    );
    res.json({
      success: true,
      brands: brands.rows.map(r => r.brand),
      locations: locations.rows.map(r => r.location),
      stats: stats.rows[0]
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
      brands,
      locations,
      delivery_preference,
      sort_by
    } = req.body;

    // Get all available yachts
    const { rows: allYachts } = await pool.query(
      `SELECT * FROM yachts WHERE is_available = TRUE`
    );

    // Score each yacht
    const scored = allYachts.map(yacht => {
      let score = 0;
      let maxScore = 0;
      const reasons = [];

      // Budget match (40 points)
      maxScore += 40;
      const price = Number(yacht.price_eur);
      const bMin = budget_min ? Number(budget_min) : 0;
      const bMax = budget_max ? Number(budget_max) : Infinity;

      if (price >= bMin && price <= bMax) {
        score += 40;
        reasons.push('Within budget');
      } else if (price < bMin) {
        // Below budget — partial score based on proximity
        const diff = (bMin - price) / bMin;
        if (diff < 0.3) {
          score += Math.round(40 * (1 - diff));
          reasons.push('Slightly below budget range');
        }
      } else if (bMax !== Infinity && price > bMax) {
        // Above budget — partial score based on proximity
        const diff = (price - bMax) / bMax;
        if (diff < 0.3) {
          score += Math.round(40 * (1 - diff));
          reasons.push('Slightly above budget');
          if (yacht.has_discount) {
            score += 5;
            reasons.push(`${yacht.discount_pct}% discount available`);
          }
        }
      }

      // Length match (25 points)
      maxScore += 25;
      const len = Number(yacht.length_m);
      const lMin = length_min ? Number(length_min) : 0;
      const lMax = length_max ? Number(length_max) : Infinity;

      if (len >= lMin && len <= lMax) {
        score += 25;
        reasons.push('Ideal size');
      } else {
        const minDist = lMin ? Math.abs(len - lMin) / lMin : 0;
        const maxDist = lMax !== Infinity ? Math.abs(len - lMax) / lMax : 0;
        const dist = Math.min(minDist || maxDist, maxDist || minDist);
        if (dist < 0.25) {
          score += Math.round(25 * (1 - dist));
          reasons.push('Close to desired size');
        }
      }

      // Brand preference (20 points)
      maxScore += 20;
      if (brands && brands.length > 0) {
        if (brands.includes(yacht.brand)) {
          score += 20;
          reasons.push('Preferred brand');
        }
      } else {
        score += 10; // No preference = neutral
      }

      // Location preference (10 points)
      maxScore += 10;
      if (locations && locations.length > 0) {
        if (locations.includes(yacht.location)) {
          score += 10;
          reasons.push('Preferred location');
        }
      } else {
        score += 5; // No preference = neutral
      }

      // Delivery bonus (5 points)
      maxScore += 5;
      if (delivery_preference === 'immediate' && yacht.delivery === 'Ready') {
        score += 5;
        reasons.push('Available immediately');
      } else if (delivery_preference === '2026' && yacht.delivery?.includes('2026')) {
        score += 5;
        reasons.push('2026 delivery');
      } else if (delivery_preference === '2027' && yacht.delivery?.includes('2027')) {
        score += 5;
        reasons.push('2027 delivery');
      } else if (!delivery_preference) {
        score += 3;
      }

      // Discount bonus
      if (yacht.has_discount && yacht.discount_pct > 0) {
        score += 3;
        if (!reasons.some(r => r.includes('discount'))) {
          reasons.push(`${yacht.discount_pct}% discount available`);
        }
      }

      // Broker commission bonus
      if (yacht.broker_commission_pct > 0) {
        score += 2;
        reasons.push(`${yacht.broker_commission_pct}% broker commission`);
      }

      const relevance = Math.min(100, Math.round((score / maxScore) * 100));

      return {
        ...yacht,
        relevance_score: relevance,
        match_reasons: reasons
      };
    });

    // Filter: only return yachts with relevance >= 20
    let results = scored.filter(y => y.relevance_score >= 20);

    // Sort
    if (sort_by === 'price_asc') {
      results.sort((a, b) => Number(a.price_eur) - Number(b.price_eur));
    } else if (sort_by === 'price_desc') {
      results.sort((a, b) => Number(b.price_eur) - Number(a.price_eur));
    } else if (sort_by === 'length_desc') {
      results.sort((a, b) => Number(b.length_m) - Number(a.length_m));
    } else if (sort_by === 'length_asc') {
      results.sort((a, b) => Number(a.length_m) - Number(b.length_m));
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
        brands && brands.length > 0 ? brands : null,
        locations && locations.length > 0 ? locations : null,
        delivery_preference || null,
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
      (SELECT ps.title FROM prospect_signals ps WHERE ps.prospect_id = p.id ORDER BY ps.detected_at DESC LIMIT 1) as latest_signal_title
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

// Serve landing page for root
app.get('/', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.json({ message: 'BarnesOS Yacht Matchmaker' });
  }
});

// Serve deal flow tracker admin page
app.get('/deals', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'deals.html');
  if (fs.existsSync(htmlPath)) {
    res.type('html').sendFile(htmlPath);
  } else {
    res.status(404).json({ message: 'Deal flow tracker not found' });
  }
});

// Serve Command Center
app.get('/command-center', (req, res) => {
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
