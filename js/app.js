// ── Config ────────────────────────────────────────────────────
const MAP_STYLE  = 'https://tiles.openfreemap.org/styles/positron';
const DATA_GEOJSON   = 'data/communes_littorales.geojson';
const DATA_NODECRET  = 'data/communes_nodecret.geojson';
const DATA_SCATTER   = 'data/scatter.json';

const COLORS = {
  quintiles: ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'],
  fort:  { fill: 'rgba(220,38,38,0.45)', stroke: '#dc2626' },
  moyen: { fill: 'rgba(251,191,36,0.30)', stroke: '#d97706' },
  dot:   { fort: '#ef4444', moyen: '#f59e0b', none: '#94a3b8' },
};

const SEMESTERS = ['2021-S1','2021-S2','2022-S1','2022-S2','2023-S1','2023-S2','2024-S1','2024-S2','2025-S1','2025-S2'];
const BEFORE_2023 = ['2021-S1','2021-S2','2022-S1','2022-S2'];

const DELTA_COLORS = ['#15803d','#86efac','#f8fafc','#fca5a5','#b91c1c'];
const DELTA_STOPS  = [-15, -5, 0, 5, 15];


function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b) => a-b);
  const m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}
function dateToSem(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()<6?'S1':'S2'}`;
}
function windowDelta(bySem, obligationDate, n) {
  if (!obligationDate) return null;
  const pi = SEMESTERS.indexOf(dateToSem(obligationDate));
  if (pi < 0) return null;
  const before = SEMESTERS.slice(Math.max(0,pi-n), pi).map(s=>bySem[s]).filter(Boolean);
  const after  = SEMESTERS.slice(pi, pi+n).map(s=>bySem[s]).filter(Boolean);
  if (!before.length || !after.length) return null;
  const mb = median(before), ma = median(after);
  return (mb && ma) ? Math.round((ma-mb)/mb*1000)/10 : null;
}

// ── State ─────────────────────────────────────────────────────
let map, priceChart, scatterChart;
let compareChartA, compareChartB;
let geojson = null, nodecretGeojson = null, scatterData = [];
let compareSelA = null, compareSelB = null;
let _scatterGroups, _buildDataset;
let mapMode = 'delta2y';
let priceYearFrom = 2021, priceYearTo = 2025;
let scatterLogX = false, scatterLogY = false;

// ── Init ──────────────────────────────────────────────────────
async function init() {
  await loadData();
  initMap();
  initScatter();
  bindNav();
  bindSearch('#search-input', '#search-results', onSearchSelect);
  bindCompare();
}

// ── Data loading ──────────────────────────────────────────────
async function loadData() {
  try {
    const [geoRes, scatRes, ncRes] = await Promise.all([
      fetch(DATA_GEOJSON),
      fetch(DATA_SCATTER),
      fetch(DATA_NODECRET).catch(() => null),
    ]);
    geojson     = await geoRes.json();
    scatterData = await scatRes.json();
    if (ncRes?.ok) nodecretGeojson = await ncRes.json();

    // Pré-calcul des deltas fenêtrés ±1 an et ±2 ans par commune
    for (const f of geojson.features) {
      const p = f.properties;
      const bySem = typeof p.price_by_semester === 'string'
        ? JSON.parse(p.price_by_semester) : (p.price_by_semester ?? {});
      const d1 = windowDelta(bySem, p.obligation_date, 2);
      const d2 = windowDelta(bySem, p.obligation_date, 4);
      if (d1 !== null) p.delta_1y = d1;
      if (d2 !== null) p.delta_2y = d2;
    }
  } catch (err) {
    document.getElementById('map-loading').innerHTML =
      `<p style="color:#ef4444;padding:20px;text-align:center">Données introuvables.<br>
       Exécutez <code>node pipeline/sample.mjs</code> pour générer les données de démo.<br>
       <small>${err.message}</small></p>`;
    throw err;
  }
}

// ── Map ───────────────────────────────────────────────────────
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [2.0, 46.8],
    zoom: 5.2,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-left');

  map.on('load', () => {
    addCommuneLayers();
    updateMapMode('delta2y');
    document.getElementById('map-loading').style.display = 'none';
  });

  map.on('click', 'communes-fill', (e) => {
    const props = e.features[0]?.properties;
    if (props) openSidebar(props);
  });
  map.on('click', 'communes-nc-fill', (e) => {
    const props = e.features[0]?.properties;
    if (props) openSidebar(props);
  });

  map.on('mouseenter', 'communes-fill',    () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'communes-fill',    () => { map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', 'communes-nc-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'communes-nc-fill', () => { map.getCanvas().style.cursor = ''; });
}

function allPriceValues() {
  const a = geojson.features.map(f => f.properties.price_median_m2).filter(v => v > 0);
  const b = (nodecretGeojson?.features ?? []).map(f => f.properties.price_median_m2).filter(v => v > 0);
  return [...a, ...b].sort((x, y) => x - y);
}

function addCommuneLayers() {
  const prices = allPriceValues();

  const q = (pct) => prices[Math.floor(prices.length * pct)] ?? prices[prices.length - 1];
  const breaks = [q(.2), q(.4), q(.6), q(.8)];

  // Store breaks globally for legend
  window._quintileBreaks = breaks;
  window._priceMin = prices[0];
  window._priceMax = prices[prices.length - 1];

  map.addSource('communes', { type: 'geojson', data: geojson });

  // Choropleth fill
  map.addLayer({
    id: 'communes-fill',
    type: 'fill',
    source: 'communes',
    paint: {
      'fill-color': [
        'case',
        ['==', ['get', 'price_median_m2'], 0], '#e2e8f0',
        ['step',
          ['get', 'price_median_m2'],
          COLORS.quintiles[0],
          breaks[0], COLORS.quintiles[1],
          breaks[1], COLORS.quintiles[2],
          breaks[2], COLORS.quintiles[3],
          breaks[3], COLORS.quintiles[4],
        ],
      ],
      'fill-opacity': 0.72,
    },
  });

  // Commune borders
  map.addLayer({
    id: 'communes-outline',
    type: 'line',
    source: 'communes',
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 9, 1.2],
      'line-opacity': 0.6,
    },
  });

  // Hover highlight
  map.addLayer({
    id: 'communes-hover',
    type: 'line',
    source: 'communes',
    paint: {
      'line-color': '#0ea5e9',
      'line-width': 2,
    },
    filter: ['==', ['get', 'code_insee'], ''],
  });

  map.on('mousemove', 'communes-fill', (e) => {
    const code = e.features[0]?.properties?.code_insee ?? '';
    map.setFilter('communes-hover', ['==', ['get', 'code_insee'], code]);
  });
  map.on('mouseleave', 'communes-fill', () => {
    map.setFilter('communes-hover', ['==', ['get', 'code_insee'], '']);
  });

  // Erosion overlay — fort (rouge plein, bordure épaisse)
  map.addLayer({
    id: 'erosion-fort-fill',
    type: 'fill',
    source: 'communes',
    filter: ['==', ['get', 'erosion_class'], 'fort'],
    paint: { 'fill-color': COLORS.fort.fill },
  });
  map.addLayer({
    id: 'erosion-fort-outline',
    type: 'line',
    source: 'communes',
    filter: ['==', ['get', 'erosion_class'], 'fort'],
    paint: { 'line-color': COLORS.fort.stroke, 'line-width': 2.5 },
  });

  // Erosion overlay — moyen (jaune-ambre, bordure pointillée)
  map.addLayer({
    id: 'erosion-moyen-fill',
    type: 'fill',
    source: 'communes',
    filter: ['==', ['get', 'erosion_class'], 'moyen'],
    paint: { 'fill-color': COLORS.moyen.fill },
  });
  map.addLayer({
    id: 'erosion-moyen-outline',
    type: 'line',
    source: 'communes',
    filter: ['==', ['get', 'erosion_class'], 'moyen'],
    paint: {
      'line-color': COLORS.moyen.stroke,
      'line-width': 2,
      'line-dasharray': [3, 2],
    },
  });

  // ── Communes côtières sans décret ──────────────────────────
  if (nodecretGeojson) {
    map.addSource('communes-nc', { type: 'geojson', data: nodecretGeojson });

    map.addLayer({
      id: 'communes-nc-fill',
      type: 'fill',
      source: 'communes-nc',
      paint: {
        'fill-color': [
          'case',
          ['==', ['get', 'price_median_m2'], 0], '#e2e8f0',
          ['step', ['get', 'price_median_m2'],
            COLORS.quintiles[0],
            breaks[0], COLORS.quintiles[1],
            breaks[1], COLORS.quintiles[2],
            breaks[2], COLORS.quintiles[3],
            breaks[3], COLORS.quintiles[4],
          ],
        ],
        'fill-opacity': 0,   // transparent par défaut (mode delta au démarrage)
      },
    }, 'communes-fill');   // insérer SOUS la couche décret

    map.addLayer({
      id: 'communes-nc-outline',
      type: 'line',
      source: 'communes-nc',
      paint: {
        'line-color': '#94a3b8',
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 9, 1.5],
        'line-opacity': 0.7,
      },
    }, 'communes-fill');

    map.addLayer({
      id: 'communes-nc-hover',
      type: 'line',
      source: 'communes-nc',
      paint: { 'line-color': '#0ea5e9', 'line-width': 2 },
      filter: ['==', ['get', 'code_insee'], ''],
    });

    map.on('mousemove', 'communes-nc-fill', (e) => {
      const code = e.features[0]?.properties?.code_insee ?? '';
      map.setFilter('communes-nc-hover', ['==', ['get', 'code_insee'], code]);
    });
    map.on('mouseleave', 'communes-nc-fill', () => {
      map.setFilter('communes-nc-hover', ['==', ['get', 'code_insee'], '']);
    });
  }

  try { addArrowLayer(); } catch (e) { console.warn('addArrowLayer:', e); }

  // Bind map mode buttons
  document.querySelectorAll('.legend-mode-btn').forEach(btn =>
    btn.addEventListener('click', () => updateMapMode(btn.dataset.mode)));

  // Populate year selects and bind
  const YEARS = [...new Set(SEMESTERS.map(s => parseInt(s)))];
  ['year-from','year-to'].forEach(id => {
    const sel = document.getElementById(id);
    YEARS.forEach(y => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = y;
      if ((id === 'year-from' && y === YEARS[0]) || (id === 'year-to' && y === YEARS[YEARS.length-1]))
        opt.selected = true;
      sel.appendChild(opt);
    });
  });
  const onYearChange = () => {
    let from = parseInt(document.getElementById('year-from').value);
    let to   = parseInt(document.getElementById('year-to').value);
    if (from > to) { to = from; document.getElementById('year-to').value = from; }
    updateMapPrice(from, to);
  };
  document.getElementById('year-from').addEventListener('change', onYearChange);
  document.getElementById('year-to').addEventListener('change', onYearChange);

  // Toggle communes sans décret
  document.getElementById('toggle-nodecret').addEventListener('change', (e) => {
    const vis = e.target.checked ? 'visible' : 'none';
    ['communes-nc-fill','communes-nc-outline','communes-nc-hover'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    });
  });

  // Toggle erosion contours
  document.getElementById('toggle-erosion').addEventListener('change', (e) => {
    const vis = e.target.checked ? 'visible' : 'none';
    ['erosion-fort-fill','erosion-fort-outline','erosion-moyen-fill','erosion-moyen-outline']
      .forEach(id => map.setLayoutProperty(id, 'visibility', vis));
  });

  // Toggle arrows (separate)
  document.getElementById('toggle-arrows').addEventListener('change', (e) => {
    if (map.getLayer('erosion-arrows'))
      map.setLayoutProperty('erosion-arrows', 'visibility', e.target.checked ? 'visible' : 'none');
  });

  // Slider taille flèches
  document.getElementById('slider-arrows').addEventListener('input', (e) => {
    const m = parseFloat(e.target.value);
    if (map.getLayer('erosion-arrows'))
      map.setLayoutProperty('erosion-arrows', 'icon-size', arrowSizeExpr(m));
    updateArrowLegend();
  });
  updateArrowLegend();
}

function arrowSizeExpr(m) {
  const logRate = ['ln', ['+', 1, ['*', 10, ['min', ['get', 'rate'], 12]]]];
  return [
    'interpolate', ['linear'], ['zoom'],
    5,  ['*', 0.055 * m, logRate],
    10, ['*', 0.14  * m, logRate],
  ];
}

function updateArrowLegend() {
  const m    = parseFloat(document.getElementById('slider-arrows')?.value ?? 1);
  const zoom = map ? Math.max(5, Math.min(10, map.getZoom())) : 7;
  const t    = (zoom - 5) / 5;                          // 0 à zoom 5, 1 à zoom 10
  const factor = 0.055 + t * (0.14 - 0.055);           // même interpolation que la couche
  const CANVAS_H = 40, CANVAS_W = 20;
  document.querySelectorAll('.al-svg').forEach(svg => {
    const rate     = parseFloat(svg.dataset.rate);
    const iconSize = factor * m * Math.log(1 + 10 * Math.min(rate, 12));
    const h = Math.max(iconSize * CANVAS_H, 1);
    const w = Math.max(iconSize * CANVAS_W, 0.5);
    svg.setAttribute('width',  w.toFixed(2));
    svg.setAttribute('height', h.toFixed(2));
  });
}

function addArrowLayer() {
  const toArrow = (f) => f.properties.arrow_lng != null && f.properties.arrow_bearing != null
    ? {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.properties.arrow_lng, f.properties.arrow_lat] },
        properties: {
          bearing: f.properties.arrow_bearing,
          rate: f.properties.erosion_rate ?? 1,
        },
      }
    : null;

  const arrowFeatures = [
    ...geojson.features,
    ...(nodecretGeojson?.features ?? []),
  ].map(toArrow).filter(Boolean);

  if (!arrowFeatures.length) return;

  // Canvas arrow (évite les problèmes de chargement SVG data URL)
  const W = 20, H = 40;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f172a';
  // Tête de flèche (triangle pointant vers le haut)
  ctx.beginPath();
  ctx.moveTo(W / 2, 1);
  ctx.lineTo(W, 17);
  ctx.lineTo(0, 17);
  ctx.closePath();
  ctx.fill();
  // Fût
  ctx.fillRect(W / 2 - 3, 15, 6, 24);

  const imageData = ctx.getImageData(0, 0, W, H);
  map.addImage('arrow-up', { width: W, height: H, data: imageData.data });

  map.addSource('erosion-arrows', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: arrowFeatures },
  });

  map.addLayer({
    id: 'erosion-arrows',
    type: 'symbol',
    source: 'erosion-arrows',
    layout: {
      'icon-image': 'arrow-up',
      'icon-anchor': 'bottom',
      'icon-rotation-alignment': 'map',
      'icon-rotate': ['get', 'bearing'],
      'icon-size': arrowSizeExpr(1),
      'icon-allow-overlap': true,
      'visibility': 'visible',
    },
    paint: { 'icon-opacity': 0.8 },
  });

  map.on('zoom', updateArrowLegend);
}

function recomputePrice(features, sems) {
  return features.map(f => {
    const p = f.properties;
    const bySem = typeof p.price_by_semester === 'string'
      ? JSON.parse(p.price_by_semester) : (p.price_by_semester ?? {});
    const vals = sems.map(s => bySem[s]).filter(Boolean);
    const med  = vals.length ? Math.round(median(vals)) : 0;
    return { ...f, properties: { ...p, price_median_m2: med } };
  });
}

function updateMapPrice(fromYear, toYear) {
  priceYearFrom = fromYear;
  priceYearTo   = toYear;

  const sems = SEMESTERS.filter(s => {
    const y = parseInt(s);
    return y >= fromYear && y <= toYear;
  });

  const features   = recomputePrice(geojson.features, sems);
  const featuresNC = nodecretGeojson ? recomputePrice(nodecretGeojson.features, sems) : [];

  // Quintiles sur les deux jeux de données combinés
  const prices = [...features, ...featuresNC]
    .map(f => f.properties.price_median_m2).filter(v => v > 0).sort((a,b) => a-b);
  const q = pct => prices[Math.floor(prices.length * pct)] ?? prices[prices.length-1];
  window._quintileBreaks = [q(.2), q(.4), q(.6), q(.8)];
  window._priceMin = prices[0];
  window._priceMax = prices[prices.length-1];

  const priceExpr = [
    'case',
    ['==', ['get', 'price_median_m2'], 0], '#e2e8f0',
    ['step', ['get', 'price_median_m2'],
      COLORS.quintiles[0],
      window._quintileBreaks[0], COLORS.quintiles[1],
      window._quintileBreaks[1], COLORS.quintiles[2],
      window._quintileBreaks[2], COLORS.quintiles[3],
      window._quintileBreaks[3], COLORS.quintiles[4],
    ],
  ];

  map.getSource('communes').setData({ ...geojson, features });
  map.setPaintProperty('communes-fill', 'fill-color', priceExpr);

  if (nodecretGeojson && map.getLayer('communes-nc-fill')) {
    map.getSource('communes-nc').setData({ ...nodecretGeojson, features: featuresNC });
    map.setPaintProperty('communes-nc-fill', 'fill-color', priceExpr);
  }
  buildLegendPrice();
}

function buildLegend() { buildLegendPrice(); }

function buildLegendPrice() {
  document.getElementById('legend-gradient').style.background =
    `linear-gradient(to right, ${COLORS.quintiles.join(', ')})`;
  document.getElementById('legend-price-title').innerHTML =
    `Prix médian au m² <span class="legend-unit">€/m²</span>`;

  const min = window._priceMin, max = window._priceMax;
  const breaks = window._quintileBreaks;
  const range = max - min;
  document.getElementById('legend-ticks').innerHTML = breaks.map(b => {
    const pct = Math.round((b - min) / range * 100);
    return `<span class="legend-tick" style="left:${pct}%"></span>`;
  }).join('');
  const fmtK = v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : `${v}`;
  document.getElementById('legend-labels').innerHTML =
    [min, ...breaks, max].map(v => `<span>${fmtK(v)}</span>`).join('');
}

function buildLegendDelta(mode) {
  document.getElementById('legend-gradient').style.background =
    `linear-gradient(to right, ${DELTA_COLORS.join(', ')})`;
  document.getElementById('legend-price-title').innerHTML = mode === 'delta1y'
    ? `Variation de prix <span class="legend-unit">1 an avant·après le décret</span>`
    : `Variation de prix <span class="legend-unit">2 ans avant·après le décret</span>`;
  document.getElementById('legend-ticks').innerHTML =
    [25,50,75].map(p => `<span class="legend-tick" style="left:${p}%"></span>`).join('');
  document.getElementById('legend-labels').innerHTML =
    DELTA_STOPS.map(v => `<span>${v>0?'+':''}${v}%</span>`).join('');
}

function updateMapMode(mode) {
  mapMode = mode;
  document.querySelectorAll('.legend-mode-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.mode === mode));

  const yearRange = document.getElementById('legend-year-range');

  if (mode === 'price') {
    yearRange.classList.remove('hidden');
    updateMapPrice(priceYearFrom, priceYearTo);
    // Communes sans décret : opacité normale
    if (map.getLayer('communes-nc-fill'))
      map.setPaintProperty('communes-nc-fill', 'fill-opacity', 0.72);
  } else {
    yearRange.classList.add('hidden');
    const prop = mode === 'delta1y' ? 'delta_1y' : 'delta_2y';
    map.setPaintProperty('communes-fill', 'fill-color', [
      'case',
      ['!', ['has', prop]], '#e2e8f0',
      ['interpolate', ['linear'], ['get', prop],
        ...DELTA_STOPS.flatMap((v,i) => [v, DELTA_COLORS[i]]),
      ],
    ]);
    // Communes sans décret : transparentes (pas de décret de référence)
    if (map.getLayer('communes-nc-fill'))
      map.setPaintProperty('communes-nc-fill', 'fill-opacity', 0);
    buildLegendDelta(mode);
  }
}

// ── Sidebar ───────────────────────────────────────────────────
function openSidebar(props) {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.remove('hidden');

  document.getElementById('sb-name').textContent = props.nom ?? '—';
  document.getElementById('sb-dept').textContent = `Dép. ${props.departement ?? '??'}`;

  // Erosion badge
  const badge = document.getElementById('sb-erosion-badge');
  if (props.erosion_class === 'fort') {
    badge.textContent = 'Exposition forte';
    badge.className = 'badge badge-fort';
    badge.classList.remove('hidden');
  } else if (props.erosion_class === 'moyen') {
    badge.textContent = 'Exposition moyenne';
    badge.className = 'badge badge-moyen';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  // KPIs
  const rate   = props.erosion_rate;
  const rateEl = document.getElementById('sb-rate');
  const rateNd = document.getElementById('sb-rate-nd');
  if (rate > 0)                { rateEl.textContent = `${rate} m/an`; rateNd.hidden = true; }
  else if (props.erosion_class) { rateEl.textContent = 'N/D';          rateNd.hidden = false; }
  else                          { rateEl.textContent = '—';            rateNd.hidden = true; }

  const price = props.price_median_m2;
  document.getElementById('sb-price').textContent = price > 0 ? `${fmt(price)} €/m²` : '—';

  const delta = props.price_delta_pct;
  const deltaEl = document.getElementById('sb-delta');
  if (delta !== null && delta !== 0) {
    deltaEl.textContent = `${delta > 0 ? '+' : ''}${delta.toFixed(1)} %`;
    deltaEl.className = 'kpi-value ' + (delta >= 0 ? 'pos' : 'neg');
  } else {
    deltaEl.textContent = '—';
    deltaEl.className = 'kpi-value';
  }

  // Price chart — MapLibre serializes nested objects as JSON strings
  const byS = typeof props.price_by_semester === 'string'
    ? JSON.parse(props.price_by_semester)
    : (props.price_by_semester ?? {});
  const semStats = typeof props.price_by_semester_stats === 'string'
    ? JSON.parse(props.price_by_semester_stats)
    : (props.price_by_semester_stats ?? {});

  const labels = SEMESTERS.map(s => s.replace('-', ' '));
  const data   = SEMESTERS.map(s => byS?.[s] ?? null);

  // IC 95% pour la médiane : médiane ± 1.57 × IQR / √n  (Kendall & Stuart)
  const upperBand = SEMESTERS.map(s => {
    const med = byS[s], st = semStats[s];
    if (med == null || !st) return null;
    return Math.round(med + 1.57 * (st.q3 - st.q1) / Math.sqrt(st.n));
  });
  const lowerBand = SEMESTERS.map(s => {
    const med = byS[s], st = semStats[s];
    if (med == null || !st) return null;
    return Math.round(Math.max(0, med - 1.57 * (st.q3 - st.q1) / Math.sqrt(st.n)));
  });

  // Ligne de décret : position dynamique selon la date réelle de la commune
  const obligSemIdx = props.obligation_date
    ? SEMESTERS.indexOf(dateToSem(props.obligation_date))
    : -1;
  const lawLineValue   = obligSemIdx >= 0 ? obligSemIdx - 0.5 : -1;
  const lawLineVisible = obligSemIdx >= 0;
  const lawDateStr     = props.obligation_date
    ? new Date(props.obligation_date).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
    : null;

  const lawLabelEl = document.querySelector('.chart-law-label');
  if (lawLabelEl) {
    lawLabelEl.innerHTML = lawDateStr
      ? `◀ avant&nbsp;·&nbsp;${lawDateStr}&nbsp;·&nbsp;après ▶`
      : `◀ avant&nbsp;·&nbsp;après ▶`;
  }

  if (priceChart) priceChart.destroy();
  priceChart = new Chart(document.getElementById('price-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          // Borne supérieure IC — remplit jusqu'à la borne inférieure
          data: upperBand,
          borderColor: 'transparent',
          borderWidth: 0,
          backgroundColor: 'rgba(14,165,233,0.15)',
          pointRadius: 0,
          fill: '+1',
          tension: 0.3,
          spanGaps: true,
        },
        {
          // Borne inférieure IC
          data: lowerBand,
          borderColor: 'transparent',
          borderWidth: 0,
          backgroundColor: 'transparent',
          pointRadius: 0,
          fill: false,
          tension: 0.3,
          spanGaps: true,
        },
        {
          // Médiane
          data,
          borderColor: '#0ea5e9',
          backgroundColor: 'transparent',
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          pointRadius: 4,
          pointHoverRadius: 6,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => item.datasetIndex === 2,
          callbacks: {
            label: (ctx) => {
              if (ctx.raw == null) return 'N/D';
              const s = SEMESTERS[ctx.dataIndex];
              const st = semStats[s];
              const base = `${fmt(ctx.raw)} €/m²`;
              if (!st) return base;
              const h = Math.round(1.57 * (st.q3 - st.q1) / Math.sqrt(st.n));
              return `${base}  ±${fmt(h)} (n=${st.n})`;
            },
          },
        },
        annotation: {
          annotations: {
            lawLine: {
              type: 'line',
              scaleID: 'x',
              value: lawLineValue,
              display: lawLineVisible,
              borderColor: '#f97316',
              borderWidth: 1.5,
              borderDash: [4, 3],
              label: {
                content: lawDateStr ? `Décret ${lawDateStr}` : 'Décret',
                display: false,
              },
            },
          },
        },
      },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        y: {
          ticks: {
            font: { size: 10 },
            callback: (v) => v >= 1000
              ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k€`
              : `${v}€`,
          },
        },
      },
    },
  });

  // Store current feature for comparison
  sidebar._currentProps = props;

  document.getElementById('compare-add-btn').onclick = () => {
    addToCompare(props);
  };
}

document.getElementById('sidebar-close').onclick = () => {
  document.getElementById('sidebar').classList.add('hidden');
};

// ── Scatter ───────────────────────────────────────────────────
function initScatter() {
  const ctx = document.getElementById('scatter-chart').getContext('2d');

  _scatterGroups = [
    { label: 'Exposition forte',   cls: 'fort',  color: COLORS.dot.fort  },
    { label: 'Exposition moyenne', cls: 'moyen', color: COLORS.dot.moyen },
    { label: 'Non classée',        cls: null,    color: COLORS.dot.none  },
  ];
  const SCATTER_GROUPS = _scatterGroups;

  const symlog    = y => Math.sign(y) * Math.log10(1 + Math.abs(y));
  const symlogInv = v => Math.sign(v) * (Math.pow(10, Math.abs(v)) - 1);

  _buildDataset = (group, logX = false, logY = false, animated = false) => ({
    label: group.label,
    _cls: group.cls,
    order: 1,
    data: scatterData
      .filter(d => d.erosion_class === group.cls)
      .filter(d => !logX || (d.erosion_rate > 0))
      .map(d => ({
        x: d.erosion_rate,
        y: animated ? 0 : (logY ? symlog(d.price_delta_pct) : d.price_delta_pct),
        nom: d.nom,
        orig: d.price_delta_pct,
      })),
    backgroundColor: group.color + 'cc',
    borderColor: group.color,
    borderWidth: 1.5,
    pointRadius: 6,
    pointHoverRadius: 9,
  });
  const buildDataset = _buildDataset;

  // ── Régression linéaire avec IC 95% ─────────────────────────
  function linRegressionFull(pts) {
    const n = pts.length;
    if (n < 4) return null;
    const xMean = pts.reduce((s, p) => s + p.x, 0) / n;
    const yMean = pts.reduce((s, p) => s + p.y, 0) / n;
    const Sxx   = pts.reduce((s, p) => s + Math.pow(p.x - xMean, 2), 0);
    const Sxy   = pts.reduce((s, p) => s + (p.x - xMean) * (p.y - yMean), 0);
    if (!Sxx) return null;
    const slope     = Sxy / Sxx;
    const intercept = yMean - slope * xMean;
    const RSS  = pts.reduce((s, p) => s + Math.pow(p.y - (slope * p.x + intercept), 2), 0);
    const sRes = Math.sqrt(RSS / (n - 2));
    return { slope, intercept, sRes, xMean, Sxx, n };
  }

  // Retourne [trendLine, ciUpper, ciLower] — tous hidden par défaut
  function buildTrendDatasets(logX = false, logY = false) {
    const base = extra => ({
      type: 'line', hidden: true, tension: 0.3,
      pointRadius: 0, hitRadius: 0, fill: false,
      ...extra,
    });
    const pts = scatterData
      .filter(d => d.erosion_rate != null && d.price_delta_pct != null)
      .filter(d => !logX || d.erosion_rate > 0)
      .map(d => ({ x: d.erosion_rate, y: logY ? symlog(d.price_delta_pct) : d.price_delta_pct }));
    const reg = linRegressionFull(pts);
    if (!reg) {
      return [
        base({ label: 'Tendance',    data: [], borderColor: '#ef4444', borderWidth: 2, borderDash: [6, 3], order: 2 }),
        base({ label: '_ci_upper',   data: [], borderColor: 'transparent', backgroundColor: 'rgba(239,68,68,0.12)', fill: '+1', order: 0 }),
        base({ label: '_ci_lower',   data: [], borderColor: 'transparent', backgroundColor: 'transparent', order: 0 }),
      ];
    }
    const { slope, intercept, sRes, xMean, Sxx, n } = reg;
    const xs = pts.map(p => p.x);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const N   = 40;
    const lineData = [], upperData = [], lowerData = [];
    for (let i = 0; i <= N; i++) {
      const x  = x0 + (x1 - x0) * i / N;
      const y  = slope * x + intercept;
      const ci = 1.96 * sRes * Math.sqrt(1 / n + Math.pow(x - xMean, 2) / Sxx);
      lineData.push({ x: +x.toFixed(3), y: +y.toFixed(2) });
      upperData.push({ x: +x.toFixed(3), y: +(y + ci).toFixed(2) });
      lowerData.push({ x: +x.toFixed(3), y: +(y - ci).toFixed(2) });
    }
    return [
      base({ label: 'Tendance',  data: lineData,  borderColor: '#ef4444', borderWidth: 2, borderDash: [6, 3], pointRadius: 0, hitRadius: 8, order: 2 }),
      base({ label: '_ci_upper', data: upperData, borderColor: 'transparent', backgroundColor: 'rgba(239,68,68,0.12)', fill: '+1', order: 0 }),
      base({ label: '_ci_lower', data: lowerData, borderColor: 'transparent', backgroundColor: 'transparent', order: 0 }),
    ];
  }

  const trendDs  = buildTrendDatasets();
  const datasets = [...SCATTER_GROUPS.map(g => buildDataset(g)), trendDs[0], trendDs[1], trendDs[2]];

  scatterChart = new Chart(ctx, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        tooltip: {
          filter: item => item.datasetIndex <= SCATTER_GROUPS.length,
          callbacks: {
            label: (ctx) => {
              if (ctx.datasetIndex < SCATTER_GROUPS.length) {
                const d = ctx.raw;
                const yReal = d.orig ?? (scatterLogY ? symlogInv(d.y) : d.y);
                return `${d.nom} — recul: ${d.x} m/an, variation: ${yReal > 0 ? '+' : ''}${yReal?.toFixed(1) ?? '?'}%`;
              }
              const y = ctx.raw.y;
              const yReal = scatterLogY ? symlogInv(y) : y;
              return `Tendance estimée : ${yReal > 0 ? '+' : ''}${yReal.toFixed(1)} %`;
            },
          },
        },
        legend: {
          position: 'top',
          labels: {
            font: { size: 12 }, usePointStyle: true, pointStyleWidth: 10,
            filter: item => item.datasetIndex < SCATTER_GROUPS.length,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Taux de recul côtier (m/an)', font: { size: 12 } },
          ticks: {
            maxRotation: 0,
            callback: (v) => {
              if (scatterLogX) {
                // En log, n'afficher que les valeurs 1×10ⁿ, 2×10ⁿ, 5×10ⁿ
                if (v <= 0) return null;
                const frac = Math.log10(v) - Math.floor(Math.log10(v));
                const atNice = [0, Math.log10(2), Math.log10(5)]
                  .some(n => Math.abs(frac - n) < 0.015);
                return atNice ? `${v} m/an` : null;
              }
              return `${v} m/an`;
            },
          },
          grid: { color: '#f1f5f9' },
        },
        y: {
          title: { display: true, text: 'Variation prix médian post-2023 (%)', font: { size: 12 } },
          ticks: {
            callback: v => {
              const orig = scatterLogY ? symlogInv(v) : v;
              return `${orig > 0 ? '+' : ''}${orig.toFixed(scatterLogY ? 1 : 0)}%`;
            },
          },
          grid: { color: '#f1f5f9' },
        },
      },
    },
  });

  const TREND_IDX    = SCATTER_GROUPS.length;      // 3
  const CI_UPPER_IDX = SCATTER_GROUPS.length + 1;  // 4
  const CI_LOWER_IDX = SCATTER_GROUPS.length + 2;  // 5

  document.getElementById('toggle-log-x').addEventListener('change', (e) => {
    const isLogX = e.target.checked;
    scatterLogX = isLogX;
    scatterChart.options.scales.x.type = isLogX ? 'logarithmic' : 'linear';
    SCATTER_GROUPS.forEach((g, i) => {
      scatterChart.data.datasets[i].data = buildDataset(g, isLogX, scatterLogY).data;
    });
    const showTrend = !scatterChart.data.datasets[TREND_IDX].hidden;
    const newDs = buildTrendDatasets(isLogX, scatterLogY);
    [TREND_IDX, CI_UPPER_IDX, CI_LOWER_IDX].forEach((idx, i) => {
      Object.assign(scatterChart.data.datasets[idx], newDs[i]);
      scatterChart.data.datasets[idx].hidden = !showTrend;
    });
    scatterChart.update();
  });

  document.getElementById('toggle-log-y').addEventListener('change', (e) => {
    scatterLogY = e.target.checked;
    const isLogX = document.getElementById('toggle-log-x').checked;
    SCATTER_GROUPS.forEach((g, i) => {
      scatterChart.data.datasets[i].data = buildDataset(g, isLogX, scatterLogY).data;
    });
    const showTrend = !scatterChart.data.datasets[TREND_IDX].hidden;
    if (showTrend) {
      const newDs = buildTrendDatasets(isLogX, scatterLogY);
      [TREND_IDX, CI_UPPER_IDX, CI_LOWER_IDX].forEach((idx, i) => {
        Object.assign(scatterChart.data.datasets[idx], newDs[i]);
      });
    }
    scatterChart.update();
  });

  document.getElementById('toggle-trend').addEventListener('change', (e) => {
    const isLogX = document.getElementById('toggle-log-x').checked;
    if (e.target.checked) {
      const newDs = buildTrendDatasets(isLogX, scatterLogY);
      [TREND_IDX, CI_UPPER_IDX, CI_LOWER_IDX].forEach((idx, i) => {
        Object.assign(scatterChart.data.datasets[idx], newDs[i]);
        scatterChart.data.datasets[idx].hidden = false;
      });
    } else {
      [TREND_IDX, CI_UPPER_IDX, CI_LOWER_IDX].forEach(idx => {
        scatterChart.data.datasets[idx].hidden = true;
      });
    }
    scatterChart.update();
  });
}

// ── Comparison ────────────────────────────────────────────────
function addToCompare(props) {
  if (!compareSelA) {
    compareSelA = props;
    renderComparePanel('a', props);
  } else if (!compareSelB) {
    compareSelB = props;
    renderComparePanel('b', props);
  } else {
    compareSelA = props;
    compareSelB = null;
    renderComparePanel('a', props);
    clearComparePanel('b');
  }
  // Switch to compare view
  setView('compare');
}

function renderComparePanel(side, props) {
  const panel = document.getElementById(`compare-panel-${side}`);
  panel.classList.remove('empty');

  const byS   = props.price_by_semester ?? {};
  const labels = SEMESTERS.map(s => s.replace('-', ' '));
  const data   = SEMESTERS.map(s => byS[s] ?? null);

  const badgeHtml = props.erosion_class
    ? `<span class="badge badge-${props.erosion_class}">${props.erosion_class === 'fort' ? 'Exposition forte' : 'Exposition moyenne'}</span>`
    : '<span class="badge badge-neutral">Non classée</span>';

  const delta = props.price_delta_pct;
  const deltaStr = (delta != null && delta !== 0)
    ? `<span style="color:${delta >= 0 ? '#dc2626' : '#16a34a'}">${delta > 0 ? '+' : ''}${delta.toFixed(1)}%</span>`
    : '—';

  panel.innerHTML = `
    <div>
      <p class="compare-commune-name">${props.nom ?? '—'}</p>
      <div class="badges" style="margin-top:6px">${badgeHtml}</div>
    </div>
    <div class="kpi-row">
      <div class="kpi"><span class="kpi-label">Recul</span><span class="kpi-value">${props.erosion_rate > 0 ? props.erosion_rate + ' m/an' : '—'}</span></div>
      <div class="kpi"><span class="kpi-label">Prix médian</span><span class="kpi-value">${props.price_median_m2 > 0 ? fmt(props.price_median_m2) + ' €/m²' : '—'}</span></div>
      <div class="kpi"><span class="kpi-label">Post-2023</span><span class="kpi-value">${deltaStr}</span></div>
    </div>
    <div class="compare-canvas-wrap"><canvas id="compare-chart-${side}" height="180"></canvas></div>
  `;

  // Destroy old chart
  const oldChart = side === 'a' ? compareChartA : compareChartB;
  if (oldChart) oldChart.destroy();

  const chart = new Chart(document.getElementById(`compare-chart-${side}`).getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: side === 'a' ? '#0ea5e9' : '#a855f7',
        backgroundColor: side === 'a' ? 'rgba(14,165,233,.1)' : 'rgba(168,85,247,.1)',
        borderWidth: 2, fill: true, tension: 0.3, pointRadius: 4, spanGaps: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.raw != null ? `${fmt(c.raw)} €/m²` : 'N/D' } } },
      scales: {
        x: { ticks: { font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { font: { size: 9 }, callback: (v) => `${Math.round(v/1000)}k` } },
      },
    },
  });

  if (side === 'a') compareChartA = chart; else compareChartB = chart;
}

function clearComparePanel(side) {
  const panel = document.getElementById(`compare-panel-${side}`);
  panel.classList.add('empty');
  panel.innerHTML = `<p class="compare-placeholder">Sélectionnez une commune ${side.toUpperCase()}</p>`;
  if (side === 'a' && compareChartA) { compareChartA.destroy(); compareChartA = null; }
  if (side === 'b' && compareChartB) { compareChartB.destroy(); compareChartB = null; }
}

function bindCompare() {
  bindSearch('#compare-search-a', '#compare-results-a', (props) => {
    compareSelA = props;
    renderComparePanel('a', props);
    document.getElementById('compare-search-a').value = props.nom;
  });
  bindSearch('#compare-search-b', '#compare-results-b', (props) => {
    compareSelB = props;
    renderComparePanel('b', props);
    document.getElementById('compare-search-b').value = props.nom;
  });
}

// ── Search ────────────────────────────────────────────────────
function bindSearch(inputSel, dropdownSel, onSelect) {
  const input    = document.querySelector(inputSel);
  const dropdown = document.querySelector(dropdownSel);

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { dropdown.classList.add('hidden'); return; }

    const matches = geojson?.features
      .filter(f => f.properties.nom?.toLowerCase().includes(q))
      .slice(0, 8) ?? [];

    if (!matches.length) { dropdown.classList.add('hidden'); return; }

    dropdown.innerHTML = matches.map(f => {
      const p   = f.properties;
      const cls = p.erosion_class;
      const badgeTxt = cls === 'fort' ? 'Fort' : cls === 'moyen' ? 'Moyen' : '';
      const badgeCls = cls ? `item-badge badge-${cls}` : '';
      return `<li data-code="${p.code_insee}">
        <span>${p.nom}</span>
        <span class="item-sub">
          ${p.departement ?? ''} ${badgeTxt ? `<span class="${badgeCls}">${badgeTxt}</span>` : ''}
        </span>
      </li>`;
    }).join('');

    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => {
        const code = li.dataset.code;
        const feat = geojson.features.find(f => f.properties.code_insee === code);
        if (!feat) return;
        dropdown.classList.add('hidden');
        input.value = feat.properties.nom;
        onSelect(feat.properties);
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
}

function onSearchSelect(props) {
  // Fly to commune on the map
  if (map) {
    const feat = geojson?.features.find(f => f.properties.code_insee === props.code_insee);
    if (feat?.geometry) {
      const coords = collectCoords(feat.geometry);
      if (coords.length) {
        const lngs = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        map.fitBounds(
          [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
          { padding: 80, maxZoom: 13, duration: 600 }
        );
      }
    }
  }
  setView('map');
  openSidebar(props);
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').classList.add('hidden');
}

function collectCoords(geom) {
  if (geom.type === 'Polygon')      return geom.coordinates.flat();
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat(2);
  return [];
}

// ── Navigation ────────────────────────────────────────────────
function bindNav() {
  document.getElementById('btn-map')    .addEventListener('click', () => setView('map'));
  document.getElementById('btn-scatter').addEventListener('click', () => setView('scatter'));
  document.getElementById('btn-compare').addEventListener('click', () => setView('compare'));
  document.getElementById('btn-about')  .addEventListener('click', () => setView('about'));
}

function animateScatter() {
  if (!scatterChart || !_scatterGroups || !_buildDataset) return;
  const isLogX = document.getElementById('toggle-log-x')?.checked ?? false;

  const realData = _scatterGroups.map(g => _buildDataset(g, isLogX, scatterLogY, false).data);
  const duration = 700;
  let   start    = null;

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function tick(now) {
    if (!start) start = now;          // initialise sur le 1er frame réel, pas avant rAF
    const t    = Math.min((now - start) / duration, 1);
    const ease = easeOutCubic(t);
    _scatterGroups.forEach((g, gi) => {
      scatterChart.data.datasets[gi].data = realData[gi].map(pt => ({
        ...pt, y: pt.y * ease,
      }));
    });
    scatterChart.update('none');
    if (t < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

function setView(name) {
  ['map','scatter','compare','about'].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('active',  v === name);
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== name);
    document.getElementById(`btn-${v}`).classList.toggle('active', v === name);
    document.getElementById(`btn-${v}`).setAttribute('aria-selected', v === name);
  });
  if (name === 'scatter') {
    scatterChart?.resize();
    animateScatter();
  }
}

// ── Helpers ───────────────────────────────────────────────────
function fmt(v) {
  return v != null ? Math.round(v).toLocaleString('fr-FR') : '—';
}

// ── Boot ──────────────────────────────────────────────────────
init().catch(console.error);
