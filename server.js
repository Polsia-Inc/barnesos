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

app.listen(port, () => {
  console.log(`BarnesOS Yacht Matchmaker running on port ${port}`);
});
