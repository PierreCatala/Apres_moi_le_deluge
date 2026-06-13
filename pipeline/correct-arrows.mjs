/**
 * correct-arrows.mjs — corrige les flèches d'érosion mal placées.
 *
 * Pour chaque commune corrigée, on connaît la direction vers la mer.
 * On trouve le milieu de l'arc côtier faisant face à la mer en maximisant
 * la projection des points de frontière sur ce vecteur marin.
 *
 * Usage : node pipeline/correct-arrows.mjs
 *   (à lancer après enrich-erosion.mjs)
 */

import * as turf from '@turf/turf';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname }   from 'path';
import { fileURLToPath }      from 'url';

const __dir        = dirname(fileURLToPath(import.meta.url));
const GEOJSON      = resolve(__dir, '../data/communes_littorales.geojson');
const COASTAL_ARCS = resolve(__dir, '../data/coastal_arcs.geojson');

// sea_bearing : azimut (degrés) du centre de la commune VERS la mer.
// L'arc côtier est la portion de la frontière dans cette direction.
const SEA_BEARINGS = {
  '22251': 315,  // Pordic — Baie de Saint-Brieuc, mer au NO
  '22343':   0,  // Trébeurden — mer au N/NO → utiliser N comme approximation
  '29040': 270,  // Le Conquet — pointe extrême, mer à l'O
  '29135': 180,  // Loctudy — estuaire Odet + mer au S
  '29239':   0,  // Roscoff — mer au N (Manche)
  '29257': 315,  // Saint-Pabu — Aber Benoît, mer au NO
  '29259':   0,  // Saint-Pol-de-Léon — mer au N
  '34301': 180,  // Sète — Méditerranée au S (isthme N/S)
  '64024': 270,  // Anglet — Atlantique à l'O (côte basque)
  '64122': 270,  // Biarritz — Atlantique à l'O
  '64125': 270,  // Bidart — Atlantique à l'O
  '64189': 280,  // Ciboure — Baie de Saint-Jean-de-Luz, mer à l'O/NO
  '64249': 270,  // Guéthary — Atlantique à l'O
  '64483': 310,  // Saint-Jean-de-Luz — Baie ouverte au NO
  '66053':  90,  // Collioure — Méditerranée à l'E
  '83065': 150,  // Gassin — Golfe de Saint-Tropez au SE
  '83068': 180,  // Grimaud — Golfe de Saint-Tropez au S
  '83119': 210,  // Saint-Tropez — Golfe (quai intérieur) au SO
  '85106': 270,  // La Guérinière — Atlantique à l'O (Noirmoutier)
};

function getOuterRing(communeGeom) {
  if (communeGeom.type === 'Polygon') return communeGeom.coordinates[0];
  let maxArea = -Infinity, outerRing = null;
  for (const pc of communeGeom.coordinates) {
    const a = turf.area(turf.polygon(pc));
    if (a > maxArea) { maxArea = a; outerRing = pc[0]; }
  }
  return outerRing;
}

function getCentroid(communeGeom) {
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

// Milieu de l'arc côtier faisant face à la mer (direction seaBearingDeg).
// Prend les points de la frontière dont la projection sur le vecteur marin
// est dans les 15 % supérieurs (= le "cap" de la commune vers la mer),
// puis prend le milieu de l'arc dominant.
function seaFacingMidpoint(communeGeom, seaBearingDeg) {
  const outerRing = getOuterRing(communeGeom);
  const boundaryLine = turf.lineString(outerRing);
  const totalLen = turf.length(boundaryLine, { units: 'kilometers' });

  const seaRad = seaBearingDeg * Math.PI / 180;
  const sx = Math.sin(seaRad); // composante Est
  const sy = Math.cos(seaRad); // composante Nord

  const STEP_KM = 0.05; // 50 m pour plus de précision
  const samples = [];
  for (let d = 0; d <= totalLen; d += STEP_KM) {
    const pt = turf.along(boundaryLine, d, { units: 'kilometers' });
    const [lng, lat] = pt.geometry.coordinates;
    const proj = sx * lng + sy * lat;
    samples.push({ d, proj });
  }

  const maxProj = Math.max(...samples.map(s => s.proj));
  const minProj = Math.min(...samples.map(s => s.proj));
  const threshold = maxProj - 0.15 * (maxProj - minProj);
  const coastal = samples.filter(s => s.proj >= threshold).map(s => s.d);

  if (!coastal.length) return null;

  // Regrouper en arcs contigus, prendre le plus long
  const GAP = 3 * STEP_KM;
  const arcs = [[coastal[0]]];
  for (let i = 1; i < coastal.length; i++) {
    if (coastal[i] - coastal[i - 1] < GAP) {
      arcs[arcs.length - 1].push(coastal[i]);
    } else {
      arcs.push([coastal[i]]);
    }
  }
  if (arcs.length > 1) {
    const seamGap = coastal[0] + totalLen - coastal[coastal.length - 1];
    if (seamGap < GAP) {
      const merged = [...arcs[arcs.length - 1], ...arcs[0].map(d => d + totalLen)];
      arcs.splice(arcs.length - 1, 1);
      arcs.splice(0, 1);
      arcs.unshift(merged);
    }
  }
  const chosen = arcs.reduce((max, a) => a.length > max.length ? a : max, arcs[0]);

  // Arc sous-échantillonné (~300 m) pour export
  const sub = Math.max(1, Math.round(0.3 / STEP_KM));
  const arcCoords = [];
  for (let i = 0; i < chosen.length; i += sub) {
    arcCoords.push(turf.along(boundaryLine, chosen[i] % totalLen, { units: 'kilometers' }).geometry.coordinates);
  }
  if (arcCoords.length < 2) {
    arcCoords.push(turf.along(boundaryLine, chosen[chosen.length - 1] % totalLen, { units: 'kilometers' }).geometry.coordinates);
  }

  const midDist = chosen[Math.floor(chosen.length / 2)] % totalLen;
  const midpoint = turf.along(boundaryLine, midDist, { units: 'kilometers' }).geometry.coordinates;
  return { midpoint, arcCoords };
}

async function main() {
  console.log('\n🧭 Correction des flèches d\'érosion\n');
  const gjson = JSON.parse(await readFile(GEOJSON, 'utf8'));

  // Charger et indexer coastal_arcs.geojson
  const { existsSync } = await import('fs');
  let arcsGjson = { type: 'FeatureCollection', features: [] };
  if (existsSync(COASTAL_ARCS)) {
    arcsGjson = JSON.parse(await readFile(COASTAL_ARCS, 'utf8'));
  }
  const arcsMap = new Map(arcsGjson.features.map(f => [f.properties.code_insee, f]));

  let count = 0;

  for (const feat of gjson.features) {
    const code = feat.properties.code_insee;
    if (!(code in SEA_BEARINGS)) continue;
    if (feat.properties.arrow_bearing == null) continue;

    const info = seaFacingMidpoint(feat.geometry, SEA_BEARINGS[code]);
    if (!info) { console.log(`  ⚠ ${feat.properties.nom} : pas d'arc trouvé`); continue; }

    const { midpoint: origin, arcCoords } = info;
    const centroid = getCentroid(feat.geometry);
    const bearing  = Math.round(turf.bearing(turf.point(origin), turf.point(centroid)));

    console.log(`  ${feat.properties.nom.padEnd(28)} ${String(feat.properties.arrow_bearing).padStart(5)}° → ${String(bearing).padStart(5)}°`);

    feat.properties.arrow_lng     = +origin[0].toFixed(5);
    feat.properties.arrow_lat     = +origin[1].toFixed(5);
    feat.properties.arrow_bearing = bearing;

    // Mettre à jour l'arc côtier dans coastal_arcs.geojson
    if (arcCoords && arcCoords.length >= 2) {
      if (arcsMap.has(code)) {
        arcsMap.get(code).geometry.coordinates = arcCoords;
      } else {
        arcsMap.set(code, {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: arcCoords },
          properties: {
            code_insee:    code,
            nom:           feat.properties.nom,
            erosion_rate:  feat.properties.erosion_rate,
            erosion_class: feat.properties.erosion_class,
          },
        });
      }
    }

    count++;
  }

  await writeFile(GEOJSON, JSON.stringify(gjson, null, 2));
  arcsGjson.features = [...arcsMap.values()];
  await writeFile(COASTAL_ARCS, JSON.stringify(arcsGjson, null, 2));
  console.log(`\n✅ ${count} communes corrigées — rechargez le site.\n`);
}

main().catch(err => { console.error('\n❌', err); process.exit(1); });
