/**
 * add-nodecret-arcs.mjs — ajoute les arcs côtiers des communes sans décret
 * à coastal_arcs.geojson (sans re-lancer le pipeline complet).
 *
 * Usage : node pipeline/add-nodecret-arcs.mjs
 */

import * as turf  from '@turf/turf';
import { readFile, writeFile } from 'fs/promises';
import { existsSync }          from 'fs';
import { resolve, dirname }    from 'path';
import { fileURLToPath }       from 'url';

const __dir        = dirname(fileURLToPath(import.meta.url));
const NODECRET     = resolve(__dir, '../data/communes_nodecret.geojson');
const COASTAL_ARCS = resolve(__dir, '../data/coastal_arcs.geojson');
const ALL_COMMUNES = resolve(__dir, 'all_communes_cache.json');

// Même algorithme que dans enrich-erosion.mjs
function coastalBoundaryMidpoint(communeGeom, neighborLines) {
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

  const STEP_KM   = 0.1;
  const SHARED_KM = 0.02;
  const coastDists = [];

  for (let d = 0; d <= totalLen; d += STEP_KM) {
    const pt = turf.along(boundaryLine, d, { units: 'kilometers' });
    const isShared = neighborLines.some(line => {
      try { return turf.nearestPointOnLine(line, pt, { units: 'kilometers' }).properties.dist < SHARED_KM; }
      catch { return false; }
    });
    if (!isShared) coastDists.push(d);
  }

  if (!coastDists.length) return null;

  const GAP = 2.5 * STEP_KM;
  const arcs = [[coastDists[0]]];
  for (let i = 1; i < coastDists.length; i++) {
    if (coastDists[i] - coastDists[i - 1] < GAP) arcs[arcs.length - 1].push(coastDists[i]);
    else arcs.push([coastDists[i]]);
  }

  if (arcs.length > 1) {
    const gapAcrossSeam = coastDists[0] + totalLen - coastDists[coastDists.length - 1];
    if (gapAcrossSeam < GAP) {
      const merged = [...arcs[arcs.length - 1], ...arcs[0].map(d => d + totalLen)];
      arcs.splice(arcs.length - 1, 1);
      arcs.splice(0, 1);
      arcs.unshift(merged);
    }
  }

  // Choisir le plus long arc (pas de segments d'érosion disponibles pour guider le choix)
  const chosenArc = arcs.reduce((max, arc) => arc.length > max.length ? arc : max, arcs[0]);

  const sub = Math.max(1, Math.round(0.3 / STEP_KM));
  const arcCoords = [];
  for (let i = 0; i < chosenArc.length; i += sub) {
    arcCoords.push(turf.along(boundaryLine, chosenArc[i] % totalLen, { units: 'kilometers' }).geometry.coordinates);
  }
  const lastCoord = turf.along(boundaryLine, chosenArc[chosenArc.length - 1] % totalLen, { units: 'kilometers' }).geometry.coordinates;
  if (arcCoords.length < 2) arcCoords.push(lastCoord);

  return arcCoords;
}

async function main() {
  console.log('\n🌊 Arcs côtiers — communes sans décret\n');

  if (!existsSync(NODECRET)) {
    console.error('❌ communes_nodecret.geojson introuvable.');
    process.exit(1);
  }
  if (!existsSync(COASTAL_ARCS)) {
    console.error('❌ coastal_arcs.geojson introuvable. Lancez d\'abord enrich-erosion.mjs.');
    process.exit(1);
  }
  if (!existsSync(ALL_COMMUNES)) {
    console.error('❌ all_communes_cache.json introuvable. Lancez d\'abord enrich-erosion.mjs.');
    process.exit(1);
  }

  const ncGjson    = JSON.parse(await readFile(NODECRET, 'utf8'));
  const arcsGjson  = JSON.parse(await readFile(COASTAL_ARCS, 'utf8'));
  const allCommunes = JSON.parse(await readFile(ALL_COMMUNES, 'utf8'));

  const existingCodes = new Set(arcsGjson.features.map(f => f.properties.code_insee));

  let added = 0, failed = 0;

  for (const feat of ncGjson.features) {
    const p = feat.properties;
    if (!p.erosion_rate || p.erosion_rate <= 0) continue;
    if (existingCodes.has(p.code_insee)) continue;

    const commBbox = turf.bbox(feat);
    const BUF = 0.002;
    const neighborLines = allCommunes
      .filter(c =>
        c.code !== p.code_insee &&
        c.bbox[2] >= commBbox[0] - BUF && c.bbox[0] <= commBbox[2] + BUF &&
        c.bbox[3] >= commBbox[1] - BUF && c.bbox[1] <= commBbox[3] + BUF
      )
      .map(c => {
        try { return turf.polygonToLine({ type: 'Feature', geometry: c.geometry }); }
        catch { return null; }
      })
      .filter(Boolean);

    const arcCoords = coastalBoundaryMidpoint(feat.geometry, neighborLines);

    if (arcCoords && arcCoords.length >= 2) {
      arcsGjson.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: arcCoords },
        properties: {
          code_insee:    p.code_insee,
          nom:           p.nom,
          erosion_rate:  p.erosion_rate,
          erosion_class: p.erosion_class,
        },
      });
      existingCodes.add(p.code_insee);
      added++;
      process.stdout.write('.');
    } else {
      failed++;
      process.stdout.write('×');
    }
  }

  console.log(`\n`);
  await writeFile(COASTAL_ARCS, JSON.stringify(arcsGjson, null, 2));
  console.log(`✅ ${added} arcs ajoutés${failed ? `, ${failed} non trouvés` : ''} — rechargez le site.\n`);
}

main().catch(err => { console.error('\n❌', err); process.exit(1); });
