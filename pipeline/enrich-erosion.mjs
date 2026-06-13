/**
 * enrich-erosion.mjs — enrichit communes_littorales.geojson avec les
 * données réelles d'évolution du trait de côte (GéoLittoral / Cerema 2018).
 *
 * Usage : node pipeline/enrich-erosion.mjs
 */

import shapefile from 'shapefile';
import proj4      from 'proj4';
import * as turf  from '@turf/turf';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';

const __dir       = dirname(fileURLToPath(import.meta.url));
const SHP         = resolve(__dir, 'erosion_shp/N_evolution_trait_cote_fr_epsg2154_S.shp');
const GEOJSON     = resolve(__dir, '../data/communes_littorales.geojson');
const SCATTER     = resolve(__dir, '../data/scatter.json');
const COASTAL_ARCS = resolve(__dir, '../data/coastal_arcs.geojson');
const SHP_ZIP = 'https://geolittoral.din.developpement-durable.gouv.fr/telechargement/couches_sig/N_evolution_trait_cote_S_fr_epsg2154_062018_shape.zip';

// Carto nationale : communes des départements côtiers (source : geo.api.gouv.fr)
const COASTAL_DEPTS    = ['06','11','13','14','17','22','29','30','33','34','35','40','44','50','56','59','62','64','66','76','80','83','85','2A','2B'];
const ALL_COMMUNES_CACHE = resolve(__dir, 'all_communes_cache.json');

// ── Proj4 : Lambert 93 → WGS84 ────────────────────────────────
const L93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
proj4.defs('EPSG:2154', L93);
const toWGS84 = proj4('EPSG:2154', 'WGS84');

function reprojectCoords(c) {
  if (!Array.isArray(c)) return c;
  if (typeof c[0] === 'number') return toWGS84.forward(c);
  return c.map(reprojectCoords);
}
function reprojectGeometry(g) {
  return g ? { ...g, coordinates: reprojectCoords(g.coordinates) } : null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classifyTaux(taux) {
  if (!taux || taux === -9999) return null;
  if (taux < -1.5) return 'fort';
  if (taux < 0)    return 'moyen';
  return null;
}

// ── Carto nationale des communes ──────────────────────────────
async function ensureAllCommunes() {
  if (existsSync(ALL_COMMUNES_CACHE)) {
    const data = JSON.parse(await readFile(ALL_COMMUNES_CACHE, 'utf8'));
    console.log(`  Communes (cache) : ${data.length}`);
    return data;
  }

  console.log('  Téléchargement carto nationale des communes (une seule fois)…');
  const all = [];
  for (const dept of COASTAL_DEPTS) {
    process.stdout.write(`  dept ${dept}… `);
    try {
      const res = await fetch(
        `https://geo.api.gouv.fr/communes?codeDepartement=${dept}&fields=code&format=geojson&geometry=contour`
      );
      if (!res.ok) { console.log(`skip (${res.status})`); continue; }
      const gj = await res.json();
      for (const f of gj.features ?? []) {
        if (!f.geometry) continue;
        all.push({ code: f.properties.code, bbox: turf.bbox(f), geometry: f.geometry });
      }
      console.log(`${(gj.features ?? []).length}`);
    } catch (err) { console.log(`ERREUR: ${err.message}`); }
  }

  await writeFile(ALL_COMMUNES_CACHE, JSON.stringify(all));
  console.log(`  → ${all.length} communes mises en cache`);
  return all;
}

// ── Shapefile érosion ─────────────────────────────────────────
async function ensureShapefile() {
  if (existsSync(SHP)) { console.log('  Shapefile érosion déjà présent.'); return; }
  console.log('  Téléchargement depuis GéoLittoral…');
  const res = await fetch(SHP_ZIP);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const zipPath = resolve(__dir, 'erosion.zip');
  await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
  const { execSync } = await import('child_process');
  await mkdir(resolve(__dir, 'erosion_shp'), { recursive: true });
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${resolve(__dir, 'erosion_shp')}' -Force"`);
}

async function loadErosionSegments() {
  console.log('\n── Shapefile érosion ──');
  const src = await shapefile.open(SHP);
  const segs = [];
  let skip = 0;
  while (true) {
    const { value, done } = await src.read();
    if (done) break;
    const taux = value.properties?.taux;
    if (!taux || taux === -9999 || value.properties?.amenagemen === 1) { skip++; continue; }
    const g = reprojectGeometry(value.geometry);
    if (g) segs.push({ taux, geom: g });
  }
  console.log(`  ${segs.length} segments valides (${skip} ignorés)`);
  return segs;
}

// ── Milieu de la frontière littorale ─────────────────────────
// Points côtiers = points à plus de 20 m de toute frontière voisine.
// Les segments d'érosion (matchGeoms) servent à choisir le bon arc
// côtier quand la commune a plusieurs faces aquatiques (estuaire, lagune…).
function coastalBoundaryMidpoint(communeGeom, neighborLines, matchGeoms) {
  // Anneau extérieur du plus grand polygone
  let outerRing;
  if (communeGeom.type === 'Polygon') {
    outerRing = communeGeom.coordinates[0];
  } else {
    let maxArea = -Infinity;
    for (const pc of communeGeom.coordinates) {
      const a = turf.area(turf.polygon(pc));
      if (a > maxArea) { maxArea = a; outerRing = pc[0]; }
    }
  }
  const boundaryLine = turf.lineString(outerRing);
  const totalLen = turf.length(boundaryLine, { units: 'kilometers' });

  const STEP_KM   = 0.1;   // échantillonnage tous les 100 m
  const SHARED_KM = 0.02;  // seuil "partagé avec un voisin" = 20 m
  const coastDists = [];

  for (let d = 0; d <= totalLen; d += STEP_KM) {
    const pt = turf.along(boundaryLine, d, { units: 'kilometers' });
    const isShared = neighborLines.some(line => {
      try {
        return turf.nearestPointOnLine(line, pt, { units: 'kilometers' }).properties.dist < SHARED_KM;
      } catch { return false; }
    });
    if (!isShared) coastDists.push(d);
  }

  if (coastDists.length === 0) return null;

  // Regrouper en arcs côtiers contigus (gap > 250 m = coupure)
  const GAP = 2.5 * STEP_KM;
  const arcs = [[coastDists[0]]];
  for (let i = 1; i < coastDists.length; i++) {
    if (coastDists[i] - coastDists[i - 1] < GAP) {
      arcs[arcs.length - 1].push(coastDists[i]);
    } else {
      arcs.push([coastDists[i]]);
    }
  }

  // Fusionner premier et dernier arc s'ils se rejoignent autour du point de départ
  if (arcs.length > 1) {
    const gapAcrossSeam = coastDists[0] + totalLen - coastDists[coastDists.length - 1];
    if (gapAcrossSeam < GAP) {
      const merged = [...arcs[arcs.length - 1], ...arcs[0].map(d => d + totalLen)];
      arcs.splice(arcs.length - 1, 1);
      arcs.splice(0, 1);
      arcs.unshift(merged);
    }
  }

  // Choisir le bon arc :
  // — si plusieurs arcs : prendre celui dont le milieu est le plus proche
  //   des centroides des segments d'érosion (qui sont sur la face marine)
  // — sinon : prendre le plus long
  let chosenArc;
  if (arcs.length === 1) {
    chosenArc = arcs[0];
  } else if (matchGeoms && matchGeoms.length > 0) {
    const segCentroids = matchGeoms.map(g =>
      turf.centroid({ type: 'Feature', geometry: g }).geometry.coordinates
    );
    let minDist = Infinity;
    chosenArc = arcs[0];
    for (const arc of arcs) {
      const midDist = arc[Math.floor(arc.length / 2)] % totalLen;
      const midPt = turf.along(boundaryLine, midDist, { units: 'kilometers' });
      const d = Math.min(...segCentroids.map(sc =>
        turf.distance(midPt, turf.point(sc), { units: 'kilometers' })
      ));
      if (d < minDist) { minDist = d; chosenArc = arc; }
    }
  } else {
    chosenArc = arcs.reduce((max, arc) => arc.length > max.length ? arc : max, arcs[0]);
  }

  const midDist = chosenArc[Math.floor(chosenArc.length / 2)] % totalLen;
  const midpoint = turf.along(boundaryLine, midDist, { units: 'kilometers' }).geometry.coordinates;

  // Arc sous-échantillonné tous les ~300 m pour export GeoJSON
  const sub = Math.max(1, Math.round(0.3 / STEP_KM));
  const arcCoords = [];
  for (let i = 0; i < chosenArc.length; i += sub) {
    arcCoords.push(turf.along(boundaryLine, chosenArc[i] % totalLen, { units: 'kilometers' }).geometry.coordinates);
  }
  const lastCoord = turf.along(boundaryLine, chosenArc[chosenArc.length - 1] % totalLen, { units: 'kilometers' }).geometry.coordinates;
  if (arcCoords.length < 2) arcCoords.push(lastCoord);

  return { midpoint, arcCoords };
}

// ── Centroïde de la commune ───────────────────────────────────
function communeCentroid(communeGeom) {
  if (communeGeom.type === 'Polygon') {
    return turf.centroid(turf.feature(communeGeom)).geometry.coordinates;
  }
  let maxArea = -Infinity, largest = null;
  for (const pc of communeGeom.coordinates) {
    const poly = turf.polygon(pc);
    const a = turf.area(poly);
    if (a > maxArea) { maxArea = a; largest = poly; }
  }
  return turf.centroid(largest).geometry.coordinates;
}

// ── Enrichissement d'une commune ──────────────────────────────
function enrichCommune(communeFeature, segments, neighborLines) {
  const communeGeom = communeFeature.geometry;
  if (!communeGeom) return null;

  const bbox = turf.bbox(communeFeature);
  const matchTaux = [], matchGeoms = [];

  for (const seg of segments) {
    const sb = turf.bbox({ type: 'Feature', geometry: seg.geom });
    if (sb[2] < bbox[0] || sb[0] > bbox[2] || sb[3] < bbox[1] || sb[1] > bbox[3]) continue;
    try {
      if (turf.intersect(turf.featureCollection([turf.feature(communeGeom), turf.feature(seg.geom)])))
        { matchTaux.push(seg.taux); matchGeoms.push(seg.geom); }
    } catch { }
  }

  if (!matchTaux.length) return null;

  const medTaux    = median(matchTaux);
  const erosionRate = medTaux < 0 ? Math.round(-medTaux * 100) / 100 : null;

  let arrowLng = null, arrowLat = null, arrowBearing = null, arcCoords = null;

  if (erosionRate > 0 && matchGeoms.length > 0) {
    const centroid = communeCentroid(communeGeom);

    // Origine = milieu de l'arc côtier le plus proche des segments d'érosion
    const info = coastalBoundaryMidpoint(communeGeom, neighborLines, matchGeoms);
    let origin;
    if (info) {
      origin    = info.midpoint;
      arcCoords = info.arcCoords;
    } else {
      origin = turf.centroid({ type: 'Feature', geometry: matchGeoms[0] }).geometry.coordinates;
    }

    arrowBearing = Math.round(turf.bearing(turf.point(origin), turf.point(centroid)));
    arrowLng     = +origin[0].toFixed(5);
    arrowLat     = +origin[1].toFixed(5);
  }

  return {
    erosion_class: classifyTaux(medTaux),
    erosion_rate:  erosionRate,
    arrow_lng:     arrowLng,
    arrow_lat:     arrowLat,
    arrow_bearing: arrowBearing,
    arcCoords,
  };
}

// ── Mise à jour du GeoJSON ────────────────────────────────────
async function enrichGeoJSON(segments, allCommunes) {
  console.log('\n── Enrichissement ──');
  const gjson = JSON.parse(await readFile(GEOJSON, 'utf8'));

  let enriched = 0;
  const scatter = [];
  const coastalArcFeatures = [];

  for (const feat of gjson.features) {
    const code    = feat.properties.code_insee;
    const commBbox = turf.bbox(feat);

    // Communes voisines candidates (bbox avec marge de 200 m)
    const BUF = 0.002;
    const neighborLines = allCommunes
      .filter(c =>
        c.code !== code &&
        c.bbox[2] >= commBbox[0] - BUF && c.bbox[0] <= commBbox[2] + BUF &&
        c.bbox[3] >= commBbox[1] - BUF && c.bbox[1] <= commBbox[3] + BUF
      )
      .map(c => {
        try { return turf.polygonToLine({ type: 'Feature', geometry: c.geometry }); }
        catch { return null; }
      })
      .filter(Boolean);

    const result = enrichCommune(feat, segments, neighborLines);

    if (result) {
      feat.properties.erosion_class  = result.erosion_class;
      feat.properties.erosion_rate   = result.erosion_rate;
      feat.properties.arrow_lng      = result.arrow_lng;
      feat.properties.arrow_lat      = result.arrow_lat;
      feat.properties.arrow_bearing  = result.arrow_bearing;
      if (result.erosion_class) enriched++;

      // Stocker l'arc côtier pour coastal_arcs.geojson
      if (result.arcCoords && result.arcCoords.length >= 2 && result.erosion_rate) {
        coastalArcFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: result.arcCoords },
          properties: {
            code_insee:    feat.properties.code_insee,
            nom:           feat.properties.nom,
            erosion_rate:  result.erosion_rate,
            erosion_class: result.erosion_class,
          },
        });
      }
    }

    const p = feat.properties;
    if (p.erosion_rate && p.price_delta_pct !== null) {
      scatter.push({
        code_insee:      p.code_insee,
        nom:             p.nom,
        erosion_rate:    p.erosion_rate,
        price_delta_pct: p.price_delta_pct,
        erosion_class:   p.erosion_class,
        price_median_m2: p.price_median_m2,
      });
    }

    process.stdout.write('.');
  }

  console.log(`\n  ${enriched} communes enrichies`);
  await writeFile(GEOJSON, JSON.stringify(gjson, null, 2));
  await writeFile(SCATTER, JSON.stringify(scatter, null, 2));
  // Sauvegarder les arcs côtiers (bruts — sera patché par correct-arrows.mjs)
  await writeFile(COASTAL_ARCS, JSON.stringify({ type: 'FeatureCollection', features: coastalArcFeatures }, null, 2));
  console.log(`  scatter.json : ${scatter.length} points — coastal_arcs.geojson : ${coastalArcFeatures.length} arcs`);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n🌊 Enrichissement érosion côtière\n');
  if (!existsSync(GEOJSON)) {
    console.error('❌ communes_littorales.geojson introuvable. Lancez d\'abord fetch.mjs.');
    process.exit(1);
  }
  await ensureShapefile();
  const [segments, allCommunes] = await Promise.all([
    loadErosionSegments(),
    ensureAllCommunes(),
  ]);
  await enrichGeoJSON(segments, allCommunes);

  // Corrections manuelles pour les communes avec géographie complexe
  const { execSync } = await import('child_process');
  execSync(`node "${resolve(__dir, 'correct-arrows.mjs')}"`, { stdio: 'inherit' });

  console.log('\n✅ Terminé — rechargez le site.\n');
}

main().catch(err => { console.error('\n❌', err); process.exit(1); });
