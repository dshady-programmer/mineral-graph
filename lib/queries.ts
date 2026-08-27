/**
 * Every Cypher query in the application, as a named export.
 *
 * Model: Country, Company, Site, Operation, Ore, Mineral, Product.
 * SHIPS runs Operation -> Operation carrying ores[], minerals[], form[].
 *
 * THE CENTRAL IDEA: `ores` is invariant along a lineage. The mineral changes
 * when it is recovered - copper ore in, cobalt hydroxide out - but the ore it
 * came from does not. So tracing provenance is an intersection over the ore
 * lists of every leg, not a rule about which mineral transitions are allowed.
 *
 * RULE: the Cypher is a constant. Values arrive only through $params.
 */

/**
 * PORTABILITY NOTE. One Cypher construct is deliberately avoided here:
 *
 *   any(x IN list WHERE predicate)  ->  size([x IN list WHERE predicate]) > 0
 *
 * The capability probe found that `any()` does not filter correctly on this
 * engine - a path predicate using it matched zero rows where the equivalent
 * list comprehension matched two.
 *
 * `last()` IS supported and is used freely; it was suspected and cleared.
 * CognoDB implements a subset of Cypher (SHOW PROCEDURES is rejected, the
 * graph algorithms library is absent), so nothing is assumed of the engine
 * that the probe has not demonstrated.
 */

/**
 * Intersect the ore lists of every leg in a path. Whatever survives is the set
 * of lineages the path can actually carry end to end.
 *
 * Ganzhou blends Congolese copper-ore cobalt with Indonesian nickel-laterite
 * cobalt, so its outbound edge carries both ores. But the leg into it from
 * Kolwezi carries only copper ore, so the intersection for that path is
 * {copper} - the blended edge accepts both traces and the upstream legs do the
 * discriminating. No guard rule needed; the data does it.
 */
const LINEAGE_ORES = `
reduce(acc = head(relationships(path)).ores, r IN relationships(path) |
       [x IN acc WHERE x IN r.ores]) AS lineageOres
`;

// ---------------------------------------------------------------------------
// Landing: products, with a light summary for the cards.
// ---------------------------------------------------------------------------
export const PRODUCTS_LIST = `
MATCH (p:Product)
OPTIONAL MATCH (p)<-[:MAKES]-(plant:Operation)-[:AT]->(:Site)-[:LOCATED_IN]->(pc:Country)
WITH p, collect(DISTINCT pc.name) AS madeIn, count(DISTINCT plant) AS plantCount
RETURN p.id          AS id,
       p.name        AS name,
       p.category    AS category,
       p.description AS description,
       madeIn        AS madeIn,
       plantCount    AS plantCount
ORDER BY name
`;

export const PRODUCT_BY_ID = `
MATCH (p:Product {id: $productId})
RETURN p.id AS id, p.name AS name, p.category AS category, p.description AS description
`;

// ---------------------------------------------------------------------------
// Product composition. The headline.
//
// One row per (mineral, ore) lineage - deliberately not per mineral, because
// cobalt from Congolese copper ore and cobalt from Indonesian nickel laterite
// are different supply lines with different geology and different risk.
// Collapsing them to "cobalt" would throw away the distinction the model
// exists to capture.
//
// The OCCURS_IN match is doing real work: it drops (mineral, ore) pairs that
// are chemically impossible, which is how a blended edge carrying two ores
// still yields only the combinations that can actually exist.
//
// The bill of materials is collected FIRST and applied as a path predicate
// before the UNWINDs, so paths delivering nothing this product needs are cut
// before they multiply out into (ore x mineral) rows.
// ---------------------------------------------------------------------------
export const PRODUCT_COMPOSITION = `
MATCH (p:Product {id: $productId})-[:REQUIRES]->(reqMineral:Mineral)
WITH p, collect(reqMineral.id) AS requiredMinerals
MATCH (p)<-[:MAKES]-(plant:Operation)
MATCH path = (origin:Operation {type: 'mining'})-[:SHIPS*1..7]->(plant)
WITH requiredMinerals, origin, path, ${LINEAGE_ORES}
WHERE size(lineageOres) > 0
  AND size([m IN last(relationships(path)).minerals
            WHERE m IN requiredMinerals]) > 0
UNWIND lineageOres AS oreId
UNWIND last(relationships(path)).minerals AS mineralId
WITH origin, path, oreId, mineralId, requiredMinerals
WHERE mineralId IN requiredMinerals
MATCH (mn:Mineral {id: mineralId})-[occ:OCCURS_IN]->(ore:Ore {id: oreId})
MATCH (origin)-[:AT]->(originSite:Site)-[:LOCATED_IN]->(originCountry:Country)
RETURN mineralId                                AS mineralId,
       mn.name                                  AS mineral,
       mn.symbol                                AS symbol,
       mn.criticality                           AS criticality,
       oreId                                    AS oreId,
       ore.name                                 AS ore,
       occ.role                                 AS role,
       collect(DISTINCT originCountry.name)     AS originCountries,
       collect(DISTINCT originSite.name)        AS originSites,
       min(length(path))                        AS shortestHops,
       count(DISTINCT path)                     AS routeCount
ORDER BY mineral, ore
`;

// ---------------------------------------------------------------------------
// Every traced route, as raw paths. The route handler folds these into the
// node and edge sets the force graph draws.
// ---------------------------------------------------------------------------
export const PRODUCT_ROUTES = `
MATCH (p:Product {id: $productId})-[:REQUIRES]->(reqMineral:Mineral)
WITH p, collect(reqMineral.id) AS requiredMinerals
MATCH (p)<-[:MAKES]-(plant:Operation)
MATCH path = (origin:Operation {type: 'mining'})-[:SHIPS*1..7]->(plant)
WITH requiredMinerals, origin, plant, path, ${LINEAGE_ORES}
WHERE size(lineageOres) > 0
  AND size([m IN last(relationships(path)).minerals
            WHERE m IN requiredMinerals]) > 0
RETURN lineageOres AS lineageOres,
       last(relationships(path)).minerals AS deliveredMinerals,
       [n IN nodes(path) | {
         id:       n.id,
         type:     n.type,
         capacity: n.capacity,
         status:   n.status
       }] AS chain,
       [r IN relationships(path) | {
         ores:     r.ores,
         minerals: r.minerals,
         form:     r.form,
         tonnage:  r.tonnage
       }] AS legs,
       length(path) AS hops
ORDER BY hops
`;

// Operation -> Site -> Country -> Company, for labelling graph nodes.
// Separate from the traversal so the path query stays readable.
export const OPERATION_DIRECTORY = `
MATCH (o:Operation)-[:AT]->(s:Site)-[:LOCATED_IN]->(c:Country)
OPTIONAL MATCH (co:Company)-[:OPERATES]->(o)
RETURN o.id     AS id,
       o.type   AS type,
       s.id     AS siteId,
       s.name   AS siteName,
       c.id     AS countryId,
       c.name   AS country,
       co.id    AS companyId,
       co.name  AS company
`;

// ---------------------------------------------------------------------------
// Which company makes this, at which plant, in which country.
// Derived, so a company with plants in three countries reads as three rows.
// ---------------------------------------------------------------------------
export const PRODUCT_PLANTS = `
MATCH (p:Product {id: $productId})<-[:MAKES]-(plant:Operation)-[:AT]->(s:Site)-[:LOCATED_IN]->(c:Country)
OPTIONAL MATCH (co:Company)-[:OPERATES]->(plant)
RETURN plant.id       AS operationId,
       s.name         AS site,
       c.name         AS country,
       co.name        AS company,
       plant.capacity AS capacity
ORDER BY company, country
`;

// ---------------------------------------------------------------------------
// The knowledge base, queried directly: what can be recovered from an ore.
// ---------------------------------------------------------------------------
export const ORE_MINERALS = `
MATCH (mn:Mineral)-[occ:OCCURS_IN]->(ore:Ore {id: $oreId})
RETURN mn.id AS mineralId, mn.name AS mineral, mn.symbol AS symbol, occ.role AS role
ORDER BY occ.role, mineral
`;

export const HEALTH = `RETURN $probe AS probe, 1 AS ok`;

export const GRAPH_SUMMARY = `
MATCH (n)
WITH head(labels(n)) AS label, count(*) AS nodes
RETURN collect({label: label, count: nodes}) AS byLabel, sum(nodes) AS totalNodes
`;

// ---------------------------------------------------------------------------
// Country disruption. "Congo restricts exports - what stops?"
//
// The unit of disruption is the OPERATION, not the mineral. A path is affected
// if ANY node on it sits in the target country - not just its origin, because
// material merely refined there is cut too when exports stop.
//
// Both counts come back per (product, mineral) so the UI can distinguish
// severed (every route runs through the country) from reduced (some routes
// survive elsewhere). A binary affected/not-affected answer would be useless:
// cobalt reaches the NMC pack from two independent lineages, and only one of
// them is Congolese.
//
// The target operations are collected into a list first so the path predicate
// is plain list membership - no pattern predicate inside `any()`, which keeps
// this to Cypher that any openCypher engine will run.
// ---------------------------------------------------------------------------
export const COUNTRY_DISRUPTION = `
MATCH (:Country {id: $countryId})<-[:LOCATED_IN]-(:Site)<-[:AT]-(o:Operation)
WITH collect(o.id) AS targetOps
MATCH (p:Product)-[:REQUIRES]->(m:Mineral)
MATCH (p)<-[:MAKES]-(plant:Operation)
MATCH path = (origin:Operation {type: 'mining'})-[:SHIPS*1..7]->(plant)
WITH targetOps, p, m, path, ${LINEAGE_ORES}
WHERE size(lineageOres) > 0
  AND m.id IN last(relationships(path)).minerals
WITH p, m, path, size([n IN nodes(path) WHERE n.id IN targetOps]) > 0 AS touched
RETURN p.id      AS productId,
       p.name    AS product,
       m.id      AS mineralId,
       m.name    AS mineral,
       m.symbol  AS symbol,
       count(path) AS totalRoutes,
       sum(CASE WHEN touched THEN 1 ELSE 0 END) AS affectedRoutes
ORDER BY product, mineral
`;

// Every operation in the target country, for the "what is actually there" panel.
export const COUNTRY_OPERATIONS = `
MATCH (:Country {id: $countryId})<-[:LOCATED_IN]-(s:Site)<-[:AT]-(o:Operation)
OPTIONAL MATCH (co:Company)-[:OPERATES]->(o)
RETURN o.id AS operationId, o.type AS type, s.name AS site, co.name AS company
ORDER BY type, site
`;

export const COUNTRIES_LIST = `
MATCH (c:Country)<-[:LOCATED_IN]-(:Site)<-[:AT]-(o:Operation)
RETURN c.id AS id, c.name AS name, count(DISTINCT o) AS operationCount
ORDER BY operationCount DESC, name
`;

// ---------------------------------------------------------------------------
// Chokepoints. Which single operation, if it went offline, cuts the most
// origin-to-product routes?
//
// This is the query that has no answer stored anywhere in the data - it only
// exists as a property of how the paths overlap. CognoDB does not ship the
// graph algorithms library, so there is no betweenness centrality to call:
// UNWIND over the nodes of every traced path and count is the hand-rolled
// equivalent, and at this graph size it is fast enough to run on request.
// ---------------------------------------------------------------------------
export const CHOKEPOINTS = `
MATCH (p:Product)-[:REQUIRES]->(reqMineral:Mineral)
WITH p, collect(reqMineral.id) AS requiredMinerals
MATCH (p)<-[:MAKES]-(plant:Operation)
MATCH path = (origin:Operation {type: 'mining'})-[:SHIPS*1..7]->(plant)
WITH requiredMinerals, path, ${LINEAGE_ORES}
WHERE size(lineageOres) > 0
  AND size([x IN last(relationships(path)).minerals
            WHERE x IN requiredMinerals]) > 0
WITH collect(path) AS paths, count(path) AS totalRoutes
UNWIND paths AS path
UNWIND nodes(path) AS n
WITH totalRoutes, n, count(DISTINCT path) AS routesThrough
MATCH (n)-[:AT]->(s:Site)-[:LOCATED_IN]->(c:Country)
OPTIONAL MATCH (co:Company)-[:OPERATES]->(n)
RETURN n.id          AS operationId,
       n.type        AS type,
       s.name        AS site,
       c.name        AS country,
       co.name       AS company,
       routesThrough AS routesThrough,
       totalRoutes   AS totalRoutes
ORDER BY routesThrough DESC, site
`;

// Ore and mineral display names, so the graph can label an edge with
// "Cobalt from Copper ore" rather than "mnrl:co / ore:copper".
export const ORE_AND_MINERAL_NAMES = `
MATCH (o:Ore)
WITH collect({id: o.id, name: o.name}) AS ores
MATCH (m:Mineral)
RETURN ores AS ores, collect({id: m.id, name: m.name, symbol: m.symbol}) AS minerals
`;
