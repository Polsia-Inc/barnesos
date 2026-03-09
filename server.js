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

app.listen(port, () => {
  console.log(`BarnesOS Yacht Matchmaker running on port ${port}`);
});
