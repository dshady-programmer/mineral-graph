/**
 * CognoDB capability probe.
 *
 * Run this BEFORE the seed script. Its job is to find out, in ninety seconds,
 * whether CognoDB can actually do the things this app depends on - rather than
 * discovering at hour thirty that one of them is missing.
 *
 *   npm i neo4j-driver
 *   node probe.mjs
 *
 * Every check is independent and wrapped in try/catch, so one failure does not
 * hide the rest. Everything it creates uses Probe* labels and is deleted at the
 * end, so it is safe to run against a seeded database.
 */

import neo4j from 'neo4j-driver';
import { readFileSync } from 'node:fs';

function loadEnvFile(path = '.env.local') {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* rely on real env vars */ }
}
loadEnvFile();

const { COGNODB_URI, COGNODB_USER, COGNODB_PASSWORD } = process.env;
if (!COGNODB_URI || !COGNODB_USER || !COGNODB_PASSWORD) {
  console.error('Missing COGNODB_URI / COGNODB_USER / COGNODB_PASSWORD.');
  console.error('Copy .env.example to .env.local and fill in the console values.');
  process.exit(1);
}

// The bolt+s:// scheme already declares TLS. Passing `encrypted` or `trust`
// here as well makes the driver throw at construction time.
const driver = neo4j.driver(
  COGNODB_URI,
  neo4j.auth.basic(COGNODB_USER, COGNODB_PASSWORD),
  {
    // Without this, every integer comes back as a {low, high} object and
    // silently breaks JSON responses.
    disableLosslessIntegers: true,
    maxConnectionPoolSize: 5,
    connectionTimeout: 5_000,
    connectionAcquisitionTimeout: 8_000,
    maxTransactionRetryTime: 6_000,
  }
);

const results = [];

/**
 * Assert inside a check. MUST throw - an earlier version of this file returned
 * a descriptive string on failure instead, which check() then logged as PASS.
 * The probe reported "all critical capabilities present" while the idempotent
 * MERGE test was failing. A probe that can report success on a failed
 * assertion is worse than no probe.
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, note, fn) {
  const session = driver.session();
  try {
    const value = await fn(session);
    results.push({ name, ok: true, value, note });
    console.log(`  PASS  ${name}${value !== undefined ? ` - ${value}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message, note });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message.split('\n')[0]}`);
  } finally {
    await session.close();
  }
}

async function main() {
  console.log(`\nProbing ${COGNODB_URI}\n`);

  try {
    const info = await driver.getServerInfo();
    console.log(`  PASS  connectivity - ${info.address} (Bolt ${info.protocolVersion})`);
  } catch (err) {
    console.error(`  FAIL  connectivity\n        ${err.message}`);
    console.error('\nStop here. Check the URI was copied exactly (including bolt+s://),');
    console.error('the password is right, and the instance finished provisioning.');
    await driver.close();
    process.exit(1);
  }

  // 1. Every query in the app looks like this: constant Cypher, values in params.
  await check('parameterised query', 'baseline for every query', async (s) => {
    const r = await s.run('RETURN $greeting AS g, $depth AS d', { greeting: 'hello', depth: 3 });
    return `${r.records[0].get('g')} / depth=${r.records[0].get('d')}`;
  });

  // 2. Neo4j 5 constraint syntax. Neo4j 4 used `ASSERT` instead of `REQUIRE`;
  //    if this fails, the seed script needs the older form.
  await check('uniqueness constraint (Neo4j 5 syntax)', 'the seed MERGE depends on this', async (s) => {
    await s.run('CREATE CONSTRAINT probe_op_id IF NOT EXISTS FOR (n:ProbeOp) REQUIRE n.id IS UNIQUE');
    return 'created';
  });

  // 3. Operation.type carries the role that labels used to, so filtering by it
  //    needs its own index or every origin lookup is a full label scan.
  await check('property index', 'Operation.type lookups depend on this', async (s) => {
    await s.run('CREATE INDEX probe_op_type IF NOT EXISTS FOR (n:ProbeOp) ON (n.type)');
    return 'created';
  });

  // 4. LIST PROPERTIES ON RELATIONSHIPS. The whole model rests on this: a SHIPS
  //    edge carries ores[] and minerals[]. If CognoDB rejected list-valued
  //    relationship properties, the data model would not be expressible.
  await check('list properties on relationships', 'SHIPS carries ores[] and minerals[]', async (s) => {
    await s.run(`
      MERGE (a:ProbeOp {id: 'p-mine'})  SET a.type = 'mining'
      MERGE (b:ProbeOp {id: 'p-conc'})  SET b.type = 'concentration'
      MERGE (c:ProbeOp {id: 'p-ref'})   SET c.type = 'refining'
      MERGE (d:ProbeOp {id: 'p-plant'}) SET d.type = 'manufacturing'
    `);
    // NOTE ON MERGE: the four nodes above are merged individually FIRST, so
    // below they arrive as already-bound variables and MERGE only creates the
    // relationship. Writing it as one pattern -
    //   MERGE (a:ProbeOp {id:'p-mine'})-[:SHIPS]->(b:ProbeOp {id:'p-conc'})
    // - would be a bug: MERGE creates the ENTIRE pattern when any part of it is
    // missing, so a missing relationship between two existing nodes produces a
    // duplicate of both nodes as well.
    await s.run(`
      MATCH (a:ProbeOp {id: 'p-mine'}), (b:ProbeOp {id: 'p-conc'})
      MERGE (a)-[r:PROBE_SHIPS {ores: ['ore:copper'], minerals: [], form: ['ore']}]->(b)
      SET r.tonnage = 45000
    `);
    const r = await s.run(`
      MATCH (:ProbeOp {id: 'p-mine'})-[r:PROBE_SHIPS]->(:ProbeOp {id: 'p-conc'})
      RETURN r.ores AS ores, size(r.minerals) AS mineralCount
    `);
    const rec = r.records[0];
    assert(rec.get('mineralCount') === 0, 'empty list property did not round-trip');
    return `ores=[${rec.get('ores')}] emptyMineralList=true`;
  });

  // 5. MERGE keyed on a list must be IDEMPOTENT. Cypher compares lists by exact
  //    equality INCLUDING ORDER, so an unsorted key silently creates a second
  //    edge on the next seed run. The seed script sorts every list before
  //    writing; this proves that the sorted form re-merges cleanly.
  await check('MERGE keyed on a list is idempotent', 'proves the seed can be re-run safely', async (s) => {
    const cypher = `
      MATCH (b:ProbeOp {id: 'p-conc'}), (c:ProbeOp {id: 'p-ref'})
      MERGE (b)-[r:PROBE_SHIPS {ores: $ores, minerals: $minerals, form: $form}]->(c)
      SET r.tonnage = $tonnage
    `;
    const params = { ores: ['ore:copper'], minerals: ['mnrl:co'], form: ['hydroxide'], tonnage: 60000 };
    await s.run(cypher, params);
    await s.run(cypher, params); // second run must NOT create a second edge
    const r = await s.run(`
      MATCH (:ProbeOp {id: 'p-conc'})-[r:PROBE_SHIPS]->(:ProbeOp {id: 'p-ref'})
      RETURN count(r) AS n
    `);
    const n = r.records[0].get('n');
    assert(n === 1, `two identical merges produced ${n} edges, not 1 - MERGE on a list key is not idempotent here`);
    return '1 edge after two identical merges';
  });

  // 5b. THE FIX for the above. MERGE on a single scalar key, then SET the lists
  //     afterwards. This is what the seed script does, so if check 5 fails and
  //     this one passes, seeding is still safe.
  await check('MERGE keyed on a scalar is idempotent', 'the seed script depends on this', async (s) => {
    const cypher = `
      MATCH (a:ProbeOp {id: 'p-mine'}), (c:ProbeOp {id: 'p-ref'})
      MERGE (a)-[r:PROBE_SCALAR {stream_id: $streamId}]->(c)
      SET r.ores = $ores, r.minerals = $minerals, r.tonnage = $tonnage
    `;
    const params = {
      streamId: 'p-mine|p-ref|ore:copper|mnrl:co',
      ores: ['ore:copper'], minerals: ['mnrl:co'], tonnage: 1234,
    };
    await s.run(cypher, params);
    await s.run(cypher, params);
    await s.run(cypher, params);
    const r = await s.run(`
      MATCH (:ProbeOp {id: 'p-mine'})-[r:PROBE_SCALAR]->(:ProbeOp {id: 'p-ref'})
      RETURN count(r) AS n, collect(DISTINCT r.ores)[0] AS ores
    `);
    const n = r.records[0].get('n');
    assert(n === 1, `three identical merges on a scalar key produced ${n} edges, not 1`);
    return `1 edge after three merges, lists intact (ores=[${r.records[0].get('ores')}])`;
  });

  // 6. Two distinct material streams between the SAME pair of operations must
  //    stay separate. If they collapsed, the graph would invent routes that do
  //    not physically exist.
  await check('distinct streams between the same pair', 'mineral/form must discriminate', async (s) => {
    await s.run(`
      MATCH (c:ProbeOp {id: 'p-ref'}), (d:ProbeOp {id: 'p-plant'})
      MERGE (c)-[r1:PROBE_SHIPS {ores: ['ore:copper'], minerals: ['mnrl:co'], form: ['sulphate']}]->(d)
      SET r1.tonnage = 78000
      MERGE (c)-[r2:PROBE_SHIPS {ores: ['ore:copper'], minerals: ['mnrl:cu'], form: ['cathode']}]->(d)
      SET r2.tonnage = 30000
    `);
    const r = await s.run(`
      MATCH (:ProbeOp {id: 'p-ref'})-[r:PROBE_SHIPS]->(:ProbeOp {id: 'p-plant'})
      RETURN count(r) AS n
    `);
    const n = r.records[0].get('n');
    assert(n === 2, `expected 2 distinct streams, got ${n} - they collapsed into one edge`);
    return '2 separate streams kept';
  });

  // 7. Variable-length traversal. Every screen in the app depends on it.
  await check('variable-length path *1..7', 'composition, disruption and chokepoints', async (s) => {
    const r = await s.run(`
      MATCH (a:ProbeOp {id: 'p-mine'})-[:PROBE_SHIPS*1..7]->(b:ProbeOp)
      RETURN collect(DISTINCT b.id) AS reached
    `);
    return r.records[0].get('reached').join(' -> ');
  });

  // 8. THE CORE MECHANISM. reduce() intersecting the ore lists of every leg is
  //    what makes provenance traceable through a blended node. If this does not
  //    work, the data model has no way to answer its headline question.
  await check('reduce() list intersection over a path', 'the lineage guard - nothing works without it', async (s) => {
    const r = await s.run(`
      MATCH path = (a:ProbeOp {id: 'p-mine'})-[:PROBE_SHIPS*1..7]->(d:ProbeOp {id: 'p-plant'})
      WITH path, reduce(acc = head(relationships(path)).ores, r IN relationships(path) |
                        [x IN acc WHERE x IN r.ores]) AS lineageOres
      WHERE size(lineageOres) > 0
      RETURN collect(DISTINCT lineageOres) AS lineages, count(path) AS paths
    `);
    const rec = r.records[0];
    return `${rec.get('paths')} path(s), lineages ${JSON.stringify(rec.get('lineages'))}`;
  });

  // 9a. Isolate how to read the LAST element of a list. `last()` is standard
  //     Cypher but not guaranteed on a subset implementation, and every query
  //     needs the final leg of a path. Three forms, tested separately so a
  //     failure names the culprit instead of hiding behind a zero result.
  await check('last leg via index arithmetic', 'the form the queries actually use', async (s) => {
    const r = await s.run(`
      MATCH path = (a:ProbeOp {id: 'p-mine'})-[:PROBE_SHIPS*1..7]->(d:ProbeOp {id: 'p-plant'})
      WITH relationships(path)[size(relationships(path)) - 1] AS lastLeg
      RETURN collect(DISTINCT lastLeg.minerals) AS delivered
    `);
    const delivered = r.records[0].get('delivered');
    assert(delivered.length > 0 && delivered.some((x) => x && x.length > 0),
           'index arithmetic returned no minerals - the queries cannot read the final leg');
    return `delivered ${JSON.stringify(delivered)}`;
  });

  await check('last() built-in', 'used throughout the queries', async (s) => {
    const r = await s.run(`
      MATCH path = (a:ProbeOp {id: 'p-mine'})-[:PROBE_SHIPS*1..7]->(d:ProbeOp {id: 'p-plant'})
      RETURN collect(DISTINCT last(relationships(path)).minerals) AS delivered
    `);
    const delivered = r.records[0].get('delivered');
    assert(delivered.some((x) => x && x.length > 0),
           'last() returned nothing - swap it for relationships(path)[size(relationships(path)) - 1]');
    return `supported - ${JSON.stringify(delivered)}`;
  });

  // 9c. any() is EXPECTED TO FAIL on CognoDB. Identical to the comprehension
  //     test below except for the predicate form, so a difference between the
  //     two isolates any() as the cause rather than leaving it ambiguous.
  //     This is why every membership test in lib/queries.ts is written as
  //     size([x IN list WHERE ...]) > 0 instead.
  await check('any() predicate (expected to FAIL here)', 'documents why the queries avoid any()', async (s) => {
    const r = await s.run(`
      WITH ['mnrl:co', 'mnrl:li'] AS requiredMinerals
      MATCH path = (a:ProbeOp {id: 'p-mine'})-[:PROBE_SHIPS*1..7]->(d:ProbeOp {id: 'p-plant'})
      WITH requiredMinerals, path,
           relationships(path)[size(relationships(path)) - 1] AS lastLeg
      WHERE any(m IN lastLeg.minerals WHERE m IN requiredMinerals)
      RETURN count(path) AS kept
    `);
    const kept = r.records[0].get('kept');
    assert(kept > 0, `any() matched ${kept} paths where the list comprehension matches 2 - confirmed unusable`);
    return `${kept} path(s) - any() works after all, the comprehension form is still correct`;
  });

  // 9b. The membership test the bill of materials uses. A list comprehension
  //     with a size check rather than any(), because any() is unconfirmed here.
  await check('list-comprehension membership test', 'the REQUIRES filter', async (s) => {
    const r = await s.run(`
      WITH ['mnrl:co', 'mnrl:li'] AS requiredMinerals
      MATCH path = (a:ProbeOp {id: 'p-mine'})-[:PROBE_SHIPS*1..7]->(d:ProbeOp {id: 'p-plant'})
      WITH requiredMinerals, path,
           relationships(path)[size(relationships(path)) - 1] AS lastLeg
      WHERE size([m IN lastLeg.minerals WHERE m IN requiredMinerals]) > 0
      RETURN count(path) AS kept
    `);
    const kept = r.records[0].get('kept');
    assert(kept > 0, 'no paths matched a required mineral - the bill-of-materials filter would empty every screen');
    return `${kept} path(s) delivering a required mineral`;
  });

  // 10. UNWIND over nodes(path) - the hand-rolled chokepoint count, needed
  //     because CognoDB does not ship the graph algorithms library.
  await check('UNWIND over nodes(path)', 'the chokepoint count', async (s) => {
    const r = await s.run(`
      MATCH path = (a:ProbeOp {id: 'p-mine'})-[:PROBE_SHIPS*1..7]->(d:ProbeOp {id: 'p-plant'})
      UNWIND nodes(path) AS n
      RETURN n.id AS id, count(DISTINCT path) AS through
      ORDER BY through DESC, id
      LIMIT 3
    `);
    return r.records.map((x) => `${x.get('id')}:${x.get('through')}`).join(' ');
  });

  // 11. Documented as absent - confirm, so the chokepoint query stays hand-rolled.
  await check('gds.pageRank (expected to FAIL)', 'confirms no graph algorithms library', async (s) => {
    await s.run("CALL gds.pageRank.stream('anything')");
    return 'AVAILABLE - surprising, docs say otherwise';
  });

  await check('SHOW PROCEDURES', 'inventory of what is available', async (s) => {
    const r = await s.run('SHOW PROCEDURES YIELD name RETURN collect(name) AS names');
    const names = r.records[0].get('names');
    return `${names.length} procedures (e.g. ${names.slice(0, 5).join(', ')})`;
  });

  await check('cleanup', '', async (s) => {
    await s.run('MATCH (n:ProbeOp) DETACH DELETE n');
    await s.run('DROP CONSTRAINT probe_op_id IF EXISTS');
    await s.run('DROP INDEX probe_op_type IF EXISTS');
    return 'probe data removed';
  });

  // --- verdict
  // NOTE: 'MERGE keyed on a list is idempotent' is deliberately NOT critical.
  // It fails on CognoDB, and the seed script works around it by keying on a
  // scalar stream_id instead - which is the check that IS critical.
  const critical = [
    'list properties on relationships',
    'MERGE keyed on a scalar is idempotent',
    'distinct streams between the same pair',
    'variable-length path *1..7',
    'reduce() list intersection over a path',
    'list-comprehension membership test',
    'last() built-in',
    'uniqueness constraint (Neo4j 5 syntax)',
  ];
  const failed = results.filter((r) => critical.includes(r.name) && !r.ok);

  console.log('\n' + '-'.repeat(70));
  if (failed.length === 0) {
    console.log('All critical capabilities present. The data model and every query are viable.');
  } else {
    console.log('CRITICAL FAILURES - these block the application:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.note}`);
  }

  const gds = results.find((r) => r.name.startsWith('gds.pageRank'));
  if (gds && !gds.ok) {
    console.log('\nNo graph algorithms library, as documented. The chokepoint ranking is');
    console.log('hand-rolled in Cypher (UNWIND over nodes(path)) rather than calling');
    console.log('betweenness centrality.');
  }
  console.log('-'.repeat(70) + '\n');
}

main()
  .catch((err) => {
    console.error('\nProbe aborted:', err.message);
    process.exitCode = 1;
  })
  .finally(() => driver.close());
