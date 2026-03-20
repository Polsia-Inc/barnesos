module.exports = {
  name: '021_rework_signal_weights',

  up: async (client) => {
    console.log('[021] Reworking signal weights with yacht-first scoring...');

    // ─── 1. Update existing rule weights ─────────────────────────────────────
    // HIGH INTENT (10 pts): Yacht-specific signals — these are the strongest
    // buying signals for a yacht brokerage
    await client.query(`
      UPDATE trigger_rules
      SET score_weight = 10, category = 'high', updated_at = NOW()
      WHERE name IN ('Yacht Brand Mention', 'Boat Show Attendance')
    `);
    console.log('[021] Updated yacht signals to HIGH (10 pts)');

    // MEDIUM INTENT (5 pts): Financial/life events — wealth indicators but
    // not direct yacht intent
    await client.query(`
      UPDATE trigger_rules
      SET score_weight = 5, category = 'medium', updated_at = NOW()
      WHERE name IN (
        'Company Exit / Sale',
        'IPO Event',
        'Major Funding Round',
        'Liquidation Event',
        'CEO/Chairman Promotion',
        'Board Appointment',
        'Senior Role Change',
        'Luxury Lifestyle Signal'
      )
    `);
    console.log('[021] Updated financial/life events to MEDIUM (5 pts)');

    // LOW INTENT (2 pts): Noise signals — press presence but no buying signal
    await client.query(`
      UPDATE trigger_rules
      SET score_weight = 2, category = 'low', updated_at = NOW()
      WHERE name IN ('Major Award/Recognition', 'Yacht Account Follow')
    `);
    console.log('[021] Updated noise signals to LOW (2 pts)');

    // ─── 2. Insert new rules ──────────────────────────────────────────────────
    // HIGH: Explicit yacht transaction/charter signals
    await client.query(`
      INSERT INTO trigger_rules (name, description, category, keywords, score_weight, is_active)
      VALUES
        (
          'Yacht Purchase/Sale',
          'Direct yacht buying or selling activity — strongest buying signal',
          'high',
          ARRAY['bought a yacht', 'purchased yacht', 'yacht sale', 'sold yacht', 'new yacht delivery',
                'yacht acquisition', 'yacht handover', 'taking delivery', 'launching new yacht',
                'superyacht purchase', 'megayacht order', 'custom yacht order'],
          10,
          true
        ),
        (
          'Charter Activity',
          'Active yacht chartering — signals familiarity and intent to own',
          'high',
          ARRAY['yacht charter', 'chartering a yacht', 'chartered superyacht', 'private charter',
                'luxury charter', 'superyacht charter', 'charter week', 'charter season',
                'charter holiday', 'charter trip', 'chartered a boat'],
          10,
          true
        )
      ON CONFLICT DO NOTHING
    `);
    console.log('[021] Added HIGH intent rules: Yacht Purchase/Sale, Charter Activity');

    // MEDIUM: Wealth signals beyond basic financial events
    await client.query(`
      INSERT INTO trigger_rules (name, description, category, keywords, score_weight, is_active)
      VALUES
        (
          'Real Estate Acquisition',
          'Major property purchase (€5M+) — signals liquidity and appetite for luxury assets',
          'medium',
          ARRAY['bought property', 'real estate acquisition', 'purchased villa', 'purchased château',
                'luxury home purchase', 'penthouse acquisition', 'estate purchase', 'mansion buy',
                'waterfront property', 'island property', 'luxury residence', 'second home',
                'holiday home purchase', 'investment property'],
          5,
          true
        ),
        (
          'Wealth Ranking Appearance',
          'Appearance on billionaire/wealth rankings — confirms UHNWI status',
          'medium',
          ARRAY['billionaire list', 'rich list', 'wealth ranking', 'Forbes billionaire', 'Forbes list',
                'Bloomberg billionaire', 'Sunday Times rich list', 'Hurun list', 'wealth index',
                'net worth ranking', 'ultra-high net worth', 'UHNWI'],
          5,
          true
        )
      ON CONFLICT DO NOTHING
    `);
    console.log('[021] Added MEDIUM intent rules: Real Estate Acquisition, Wealth Ranking');

    // LOW: Noise / background signals
    await client.query(`
      INSERT INTO trigger_rules (name, description, category, keywords, score_weight, is_active)
      VALUES
        (
          'Generic Press Mention',
          'General media appearance — confirms public profile but no buying signal',
          'low',
          ARRAY['featured in', 'interview with', 'profile of', 'in conversation with',
                'speaks to', 'talks to', 'exclusive interview', 'press release',
                'spokesperson', 'commented on', 'quoted in'],
          2,
          true
        ),
        (
          'Philanthropy/Foundation',
          'Charitable activity — positive signal but no direct buying intent',
          'low',
          ARRAY['foundation', 'philanthropy', 'philanthropist', 'donated', 'donation',
                'charity gala', 'endowment', 'nonprofit', 'charitable trust',
                'gives to', 'funds', 'patron of', 'benefactor'],
          2,
          true
        ),
        (
          'Social Media Activity',
          'Non-yacht social media posts — shows public engagement, low buying signal',
          'low',
          ARRAY['posted on instagram', 'instagram story', 'twitter update', 'x post',
                'linkedin post', 'shared on social', 'social media update',
                'instagram update', 'tweeted', 'linkedin update'],
          2,
          true
        )
      ON CONFLICT DO NOTHING
    `);
    console.log('[021] Added LOW intent rules: Generic Press, Philanthropy, Social Media');

    // ─── 3. Re-score existing signals using updated rule weights ─────────────
    // prospect_signals stores trigger_rule_id + raw_data->>'multiplier'
    // Re-apply: new_score = ROUND(new_rule_weight * stored_multiplier)
    const { rowCount: rescored } = await client.query(`
      UPDATE prospect_signals ps
      SET score = GREATEST(1, ROUND(
        tr.score_weight::FLOAT
        * COALESCE((ps.raw_data->>'multiplier')::FLOAT, 1.0)
      )::INTEGER)
      FROM trigger_rules tr
      WHERE ps.trigger_rule_id = tr.id
    `);
    console.log(`[021] Re-scored ${rescored} existing signals with new rule weights`);

    // ─── 4. Recalculate all prospect tiers ───────────────────────────────────
    // Apply time decay (50% for 30-90 days, excluded >90 days) and new
    // thresholds: HOT ≥15, WARM 6-14, COLD 0-5
    const { rowCount: recalcCount } = await client.query(`
      WITH decayed_scores AS (
        SELECT
          ps.prospect_id,
          SUM(
            ROUND(
              ps.score * CASE
                WHEN EXTRACT(EPOCH FROM (NOW() - ps.detected_at)) / 86400 <= 30 THEN 1.0
                ELSE 0.5
              END
            )
          )::INTEGER AS total_score
        FROM prospect_signals ps
        WHERE ps.detected_at > NOW() - INTERVAL '90 days'
        GROUP BY ps.prospect_id
      )
      UPDATE prospects p
      SET
        heat_score = COALESCE(ds.total_score, 0),
        heat_tier  = CASE
          WHEN COALESCE(ds.total_score, 0) >= 15 THEN 'hot'
          WHEN COALESCE(ds.total_score, 0) >= 6  THEN 'warm'
          ELSE 'cold'
        END,
        updated_at = NOW()
      FROM (
        SELECT id FROM prospects
      ) all_prospects
      LEFT JOIN decayed_scores ds ON ds.prospect_id = all_prospects.id
      WHERE p.id = all_prospects.id
    `);
    console.log(`[021] Recalculated heat tiers for ${recalcCount} prospects`);
    console.log('[021] New thresholds: HOT ≥15 pts, WARM 6-14 pts, COLD 0-5 pts');
    console.log('[021] rework_signal_weights migration complete ✓');
  },

  down: async (client) => {
    // Remove new rules added in this migration
    await client.query(`
      DELETE FROM trigger_rules
      WHERE name IN (
        'Yacht Purchase/Sale',
        'Charter Activity',
        'Real Estate Acquisition',
        'Wealth Ranking Appearance',
        'Generic Press Mention',
        'Philanthropy/Foundation',
        'Social Media Activity'
      )
    `);

    // Restore original weights (pre-migration values)
    await client.query(`
      UPDATE trigger_rules SET score_weight = 3, category = 'low', updated_at = NOW()
      WHERE name IN ('Yacht Brand Mention', 'Boat Show Attendance')
    `);
    await client.query(`
      UPDATE trigger_rules SET score_weight = 10, category = 'high', updated_at = NOW()
      WHERE name IN ('Company Exit / Sale', 'IPO Event', 'Major Funding Round', 'Liquidation Event')
    `);
    await client.query(`
      UPDATE trigger_rules SET score_weight = 6, category = 'medium', updated_at = NOW()
      WHERE name IN ('CEO/Chairman Promotion', 'Board Appointment', 'Senior Role Change', 'Major Award/Recognition')
    `);
    await client.query(`
      UPDATE trigger_rules SET score_weight = 3, category = 'low', updated_at = NOW()
      WHERE name IN ('Luxury Lifestyle Signal', 'Yacht Account Follow')
    `);
    console.log('[021] Rolled back: restored original trigger rule weights');
  }
};
