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
// Auto-initialize when loaded
initGlobe();
