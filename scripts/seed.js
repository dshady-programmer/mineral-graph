/**
 * Seed the mineral supply chain graph into CognoDB.
 *
 * Model: Country, Company, Site, Operation, Ore, Mineral, Product.
 * A Site is a place. An Operation is one process unit at that place, so a site
 * that mines and concentrates has two Operation nodes and an internal SHIPS
 * edge between them.
 *
 *   node scripts/seed.mjs
 *
 * Idempotent: every write is a MERGE keyed on a deterministic id.
 */

import neo4j from 'neo4j-driver';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnvFile(path = join(ROOT, '.env.local')) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* fall back to real env vars */ }
}
loadEnvFile();

const { COGNODB_URI, COGNODB_USER, COGNODB_PASSWORD } = process.env;
if (!COGNODB_URI || !COGNODB_USER || !COGNODB_PASSWORD) {
  console.error('Missing COGNODB_URI / COGNODB_USER / COGNODB_PASSWORD.');
  process.exit(1);
}

const data = JSON.parse(readFileSync(join(ROOT, 'data', 'seed.json'), 'utf8'));

// Material moves downstream. Equal ranks are allowed (a refinery may ship to
// another refinery); rank must never decrease, and nothing ships into mining.
const STAGE_RANK = {
  mining: 0,
  concentration: 1,
  smelting: 2,
  refining: 3,
  manufacturing: 4,
};

/**
 * CRITICAL: Cypher matches list properties by exact equality INCLUDING ORDER,
 * so ['a','b'] and ['b','a'] are different values. A MERGE keyed on an
 * unsorted list creates a duplicate edge on the second seed run - silently.
 * Every list is sorted here before it is written, and this is the only place
 * that has to remember.
 */
const sorted = (xs) => [...(xs || [])].sort();

/**
 * Deterministic scalar key for a SHIPS edge.
 *
 * WHY NOT MERGE ON THE LISTS THEMSELVES: the capability probe showed that on
 * CognoDB, MERGE keyed on list-valued relationship properties is NOT
 * idempotent - running the identical MERGE twice produced two edges. Seeding
 * would therefore duplicate every shipping route on a re-run, silently
 * doubling every path count in the app.
 *
 * A scalar string key sidesteps it entirely: MERGE matches on one plain
 * property, which is the case every engine handles. The lists are then written
 * with SET, where their ordering does not matter. The key is built from sorted
 * lists so the same logical stream always produces the same id.
 */
const streamId = (row) =>
  [row.from, row.to,
   sorted(row.ores).join('+'),
   sorted(row.minerals).join('+'),
   sorted(row.form).join('+')].join('|');

function validate(d) {
  const errors = [];

  const siteIds = new Set(d.sites.map((s) => s.id));
  const opById = new Map(d.operations.map((o) => [o.id, o]));
  const oreIds = new Set(d.ores.map((o) => o.id));
  const mineralIds = new Set(d.minerals.map((m) => m.id));
  const countryIds = new Set(d.countries.map((c) => c.id));
  const companyIds = new Set(d.companies.map((c) => c.id));
  const productIds = new Set(d.products.map((p) => p.id));

  const allIds = [...siteIds, ...opById.keys(), ...oreIds, ...mineralIds, ...countryIds, ...companyIds, ...productIds];
  const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  if (dupes.length) errors.push(`Duplicate ids: ${[...new Set(dupes)].join(', ')}`);

  for (const s of d.sites) {
    if (!countryIds.has(s.country)) errors.push(`Site ${s.id} references unknown country ${s.country}`);
  }

  for (const o of d.operations) {
    if (!(o.type in STAGE_RANK)) {
      errors.push(`Operation ${o.id} has invalid type "${o.type}" (allowed: ${Object.keys(STAGE_RANK).join(', ')})`);
      continue;
    }
    if (!siteIds.has(o.site)) errors.push(`Operation ${o.id} references unknown site ${o.site}`);
    if (o.operator && !companyIds.has(o.operator)) errors.push(`Operation ${o.id} references unknown operator ${o.operator}`);
    // Only manufacturing makes products. The labels used to imply this; now it lives here.
    if (o.makes?.length && o.type !== 'manufacturing') {
      errors.push(`Operation ${o.id} (${o.type}) has MAKES - only manufacturing makes products`);
    }
    for (const p of o.makes || []) {
      if (!productIds.has(p)) errors.push(`Operation ${o.id} makes unknown product ${p}`);
    }
  }

  for (const oc of d.occurs_in) {
    if (!mineralIds.has(oc.mineral)) errors.push(`OCCURS_IN references unknown mineral ${oc.mineral}`);
    if (!oreIds.has(oc.ore)) errors.push(`OCCURS_IN references unknown ore ${oc.ore}`);
    if (!['primary', 'byproduct'].includes(oc.role)) errors.push(`OCCURS_IN ${oc.mineral}/${oc.ore} has invalid role "${oc.role}"`);
  }

  for (const c of d.companies) {
    if (c.hq_country && !countryIds.has(c.hq_country)) errors.push(`Company ${c.id} references unknown hq_country ${c.hq_country}`);
  }

  for (const rq of d.requires || []) {
    if (!productIds.has(rq.product)) errors.push(`REQUIRES references unknown product ${rq.product}`);
    if (!mineralIds.has(rq.mineral)) errors.push(`REQUIRES references unknown mineral ${rq.mineral}`);
  }
  for (const p of d.products) {
    if (!(d.requires || []).some((rq) => rq.product === p.id)) {
      errors.push(`Product ${p.id} has no REQUIRES entries - its composition would come back empty`);
    }
  }

  for (const s of d.ships) {
    const from = opById.get(s.from);
    const to = opById.get(s.to);
    if (!from) { errors.push(`SHIPS source ${s.from} is not a known Operation`); continue; }
    if (!to)   { errors.push(`SHIPS target ${s.to} is not a known Operation`); continue; }

    if (to.type === 'mining') {
      errors.push(`SHIPS ${s.from} -> ${s.to}: nothing ships into mining`);
    } else if (STAGE_RANK[from.type] > STAGE_RANK[to.type]) {
      errors.push(`SHIPS ${s.from} (${from.type}) -> ${s.to} (${to.type}): material cannot flow upstream`);
    }

    if (!s.ores?.length) errors.push(`SHIPS ${s.from} -> ${s.to} has no ores - lineage would be untraceable`);
    for (const o of s.ores || []) if (!oreIds.has(o)) errors.push(`SHIPS ${s.from} -> ${s.to} references unknown ore ${o}`);
    for (const m of s.minerals || []) if (!mineralIds.has(m)) errors.push(`SHIPS ${s.from} -> ${s.to} references unknown mineral ${m}`);
    if (typeof s.tonnage !== 'number' || s.tonnage <= 0) errors.push(`SHIPS ${s.from} -> ${s.to} has non-positive tonnage`);

    // A mineral may only be claimed against an ore it actually occurs in.
    for (const m of s.minerals || []) {
      const ok = (s.ores || []).some((ore) => d.occurs_in.some((oc) => oc.mineral === m && oc.ore === ore));
      if (!ok) errors.push(`SHIPS ${s.from} -> ${s.to} claims ${m} but it occurs in none of [${(s.ores || []).join(', ')}]`);
    }

    // A mining operation ships ore. Nothing has been recovered yet - concentrate
    // comes from a concentrator, matte from a smelter. If a site does both, it
    // gets two Operations and an internal edge between them, which is exactly
    // what the Site/Operation split is for.
    if (from.type === 'mining' && s.minerals?.length) {
      errors.push(`SHIPS ${s.from} -> ${s.to}: mining output carries ore only. ` +
                  `If ${from.site} also beneficiates, give it a concentration or smelting Operation.`);
    }
  }

  const keys = d.ships.map(streamId);
  const dupeKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupeKeys.length) errors.push(`Duplicate SHIPS keys: ${[...new Set(dupeKeys)].join(' ; ')}`);

  return errors;
}

const errors = validate(data);
if (errors.length) {
  console.error(`\nSeed data failed validation (${errors.length} problem(s)):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const byType = data.operations.reduce((a, o) => ({ ...a, [o.type]: (a[o.type] || 0) + 1 }), {});
const multiOp = data.sites.filter((s) => data.operations.filter((o) => o.site === s.id).length > 1);
console.log(`Validation passed. ${data.sites.length} sites, ${data.operations.length} operations ` +
            `(${Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(', ')}), ${data.ships.length} SHIPS edges.`);
console.log(`Multi-operation sites: ${multiOp.map((s) => s.name).join(', ') || 'none'}`);

const driver = neo4j.driver(
  COGNODB_URI,
  neo4j.auth.basic(COGNODB_USER, COGNODB_PASSWORD),
  { disableLosslessIntegers: true, maxConnectionPoolSize: 5 }
);

const CONSTRAINTS = [
  ['country_id', 'Country'], ['company_id', 'Company'], ['site_id', 'Site'],
  ['operation_id', 'Operation'], ['ore_id', 'Ore'], ['mineral_id', 'Mineral'], ['product_id', 'Product'],
];

// A uniqueness constraint indexes only the constrained property. Operation.type
// now does the discriminating work labels used to do, so "find all mining
// operations" needs its own index or it is a full label scan.
const INDEXES = [['operation_type', 'Operation', 'type']];

const run = (session, cypher, params = {}) => session.executeWrite((tx) => tx.run(cypher, params));

async function main() {
  await driver.getServerInfo();
  console.log(`\nConnected to ${COGNODB_URI}\n`);

  const session = driver.session();
  try {
    for (const [name, label] of CONSTRAINTS) {
      await run(session, `CREATE CONSTRAINT ${name} IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);
    }
    for (const [name, label, prop] of INDEXES) {
      await run(session, `CREATE INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON (n.${prop})`);
    }
    console.log(`  ${CONSTRAINTS.length} constraints, ${INDEXES.length} index ensured`);

    const nodeBatches = [
      ['Country', data.countries],
      ['Ore', data.ores],
      ['Mineral', data.minerals],
      ['Company', data.companies],
      ['Product', data.products],
      ['Site', data.sites],
      ['Operation', data.operations.map((o) => ({
        id: o.id, site: o.site, type: o.type, capacity: o.capacity, status: o.status,
      }))],
    ];

    for (const [label, rows] of nodeBatches) {
      await run(session, `UNWIND $rows AS row MERGE (n:${label} {id: row.id}) SET n += row`, { rows });
      console.log(`  ${label}: ${rows.length}`);
    }

    await run(session, `
      UNWIND $rows AS row
      MATCH (s:Site {id: row.site}) MATCH (c:Country {id: row.country})
      MERGE (s)-[:LOCATED_IN]->(c)
    `, { rows: data.sites.map((s) => ({ site: s.id, country: s.country })) });

    await run(session, `
      UNWIND $rows AS row
      MATCH (c:Company {id: row.company}) MATCH (k:Country {id: row.country})
      MERGE (c)-[:HEADQUARTERED_IN]->(k)
    `, { rows: data.companies.filter((c) => c.hq_country).map((c) => ({ company: c.id, country: c.hq_country })) });

    await run(session, `
      UNWIND $rows AS row
      MATCH (o:Operation {id: row.op}) MATCH (s:Site {id: row.site})
      MERGE (o)-[:AT]->(s)
    `, { rows: data.operations.map((o) => ({ op: o.id, site: o.site })) });

    await run(session, `
      UNWIND $rows AS row
      MATCH (c:Company {id: row.company}) MATCH (o:Operation {id: row.op})
      MERGE (c)-[:OPERATES]->(o)
    `, { rows: data.operations.filter((o) => o.operator).map((o) => ({ company: o.operator, op: o.id })) });

    await run(session, `
      UNWIND $rows AS row
      MATCH (o:Operation {id: row.op}) MATCH (p:Product {id: row.product})
      MERGE (o)-[:MAKES]->(p)
    `, { rows: data.operations.flatMap((o) => (o.makes || []).map((product) => ({ op: o.id, product }))) });

    // The knowledge base. One edge type with a role, so "everything recoverable
    // from copper ore" is a single traversal returning copper as primary and
    // cobalt as byproduct.
    await run(session, `
      UNWIND $rows AS row
      MATCH (m:Mineral {id: row.mineral}) MATCH (o:Ore {id: row.ore})
      MERGE (m)-[r:OCCURS_IN]->(o) SET r.role = row.role
    `, { rows: data.occurs_in });
    console.log(`  OCCURS_IN: ${data.occurs_in.length}`);

    // REQUIRES - the bill of materials. Without it, a plant building two
    // product lines attributes every inbound mineral to both.
    await run(session, `
      UNWIND $rows AS row
      MATCH (p:Product {id: row.product}) MATCH (m:Mineral {id: row.mineral})
      MERGE (p)-[:REQUIRES]->(m)
    `, { rows: data.requires || [] });
    console.log(`  REQUIRES: ${(data.requires || []).length}`);

    // SHIPS. MERGE on the scalar stream_id only; the lists are written with
    // SET afterwards. See streamId() above for why the lists cannot be part of
    // the MERGE pattern on this engine.
    await run(session, `
      UNWIND $rows AS row
      MATCH (a:Operation {id: row.from}) MATCH (b:Operation {id: row.to})
      MERGE (a)-[s:SHIPS {stream_id: row.stream_id}]->(b)
      SET s.ores     = row.ores,
          s.minerals = row.minerals,
          s.form     = row.form,
          s.tonnage  = row.tonnage
    `, {
      rows: data.ships.map((s) => ({
        from: s.from, to: s.to,
        stream_id: streamId(s),
        ores: sorted(s.ores), minerals: sorted(s.minerals), form: sorted(s.form),
        tonnage: s.tonnage,
      })),
    });

    // Re-running the seed must not accumulate edges. If this count ever exceeds
    // the number of rows in seed.json, the MERGE key has stopped being unique.
    const edgeCount = await session.executeRead((tx) =>
      tx.run('MATCH ()-[s:SHIPS]->() RETURN count(s) AS n'));
    const actual = edgeCount.records[0].get('n');
    if (actual !== data.ships.length) {
      console.warn(`  WARNING: ${actual} SHIPS edges in the graph but ${data.ships.length} in seed.json.`);
      console.warn('  Re-running is duplicating edges. Check the stream_id key before trusting any counts.');
    }
    console.log(`  SHIPS: ${data.ships.length}`);

    const counts = await session.executeRead((tx) => tx.run(`
      MATCH (n) WITH head(labels(n)) AS label, count(*) AS c
      RETURN collect(label + ': ' + toString(c)) AS parts
    `));
    console.log(`\nGraph now holds - ${counts.records[0].get('parts').join(', ')}`);
    console.log('Seed complete.\n');
  } finally {
    await session.close();
  }
}

main()
  .catch((err) => { console.error('\nSeed failed:', err.message); process.exitCode = 1; })
  .finally(() => driver.close());
