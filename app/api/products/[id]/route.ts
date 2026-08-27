import { NextResponse } from 'next/server';
import { read, describeDbError } from '@/lib/cogno';
import { PRODUCT_BY_ID, PRODUCT_COMPOSITION, PRODUCT_ROUTES, PRODUCT_PLANTS, OPERATION_DIRECTORY, ORE_AND_MINERAL_NAMES } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export type Composition = {
  mineralId: string; mineral: string; symbol: string; criticality: string;
  oreId: string; ore: string; role: 'primary' | 'byproduct';
  originCountries: string[]; originSites: string[];
  shortestHops: number; routeCount: number;
};

export type GraphNode = {
  id: string; type: string; stage: number;
  site: string;
  /** What the graph draws. Same as `site` unless that site has more than one
   *  operation in this graph, in which case the stage disambiguates them -
   *  otherwise Greenbushes appears twice with the same label. */
  label: string;
  country: string; company: string | null;
  isOrigin: boolean; isPlant: boolean;
  capacity: number | null; status: string | null;
  lineages: string[];
};

export type GraphEdge = {
  id: string; from: string; to: string;
  ores: string[]; minerals: string[]; form: string[]; tonnage: number;
  /** Display names, resolved server-side so the graph does not need a lookup. */
  oreNames: string[]; mineralNames: string[];
  /**
   * Which (mineral|ore) lineages this edge actually carries, as keys matching
   * the composition rows.
   *
   * This exists because filtering the highlight on ore alone was wrong: the
   * Luilu -> CATL Ningde copper cathode edge carries ore:copper, so selecting
   * "Cobalt from copper ore" lit it up even though it is on no cobalt path.
   * Lineages are collected from the traced routes themselves, so an edge is
   * only lit for a lineage it genuinely participates in.
   */
  lineages: string[];
};

/**
 * One traced route, spelled out site by site.
 *
 * The composition panel reports "15 routes, 3 origins, 3 hops min", which are
 * accurate but abstract - there is no way to see what a route IS. These make
 * each one readable and let the UI highlight exactly its links in the graph.
 */
export type RouteSummary = {
  id: string;
  steps: Array<{ id: string; label: string; type: string }>;
  edgeIds: string[];
  lineages: string[];
  hops: number;
  /** Tonnage on the final leg - what actually arrives at the plant. */
  deliveredTonnage: number;
};

export type Plant = {
  operationId: string; site: string; country: string; company: string | null; capacity: number;
};

const STAGE_RANK: Record<string, number> = {
  mining: 0, concentration: 1, smelting: 2, refining: 3, manufacturing: 4,
};

type RouteRow = {
  lineageOres: string[];
  deliveredMinerals: string[];
  chain: Array<{ id: string; type: string; capacity: number; status: string }>;
  legs: Array<{ ores: string[]; minerals: string[]; form: string[]; tonnage: number }>;
  hops: number;
};

type DirectoryRow = {
  id: string; type: string; siteId: string; siteName: string;
  countryId: string; country: string; companyId: string | null; company: string | null;
};

/**
 * GET /api/products/:id
 *
 * Everything the product page needs, in one request: composition by lineage,
 * the plants that make it, and the node/edge sets for the graph.
 *
 * One endpoint rather than four because the free tier is half a vCPU and four
 * round trips from the browser is three more than this page needs. The four
 * Cypher queries below are independent, so they run concurrently server-side.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || !id.startsWith('prod:')) {
    return NextResponse.json(
      { status: 'error', message: 'Product id must look like "prod:ev-battery-nmc".' },
      { status: 400 }
    );
  }

  try {
    const [product, composition, routes, plants, directory, names] = await Promise.all([
      read<{ id: string; name: string; category: string; description: string }>(
        PRODUCT_BY_ID, { productId: id }, (r) => ({
          id: r.get('id'), name: r.get('name'),
          category: r.get('category'), description: r.get('description'),
        })
      ),
      read<Composition>(PRODUCT_COMPOSITION, { productId: id }, (r) => ({
        mineralId: r.get('mineralId'), mineral: r.get('mineral'), symbol: r.get('symbol'),
        criticality: r.get('criticality'), oreId: r.get('oreId'), ore: r.get('ore'),
        role: r.get('role'), originCountries: r.get('originCountries'),
        originSites: r.get('originSites'), shortestHops: r.get('shortestHops'),
        routeCount: r.get('routeCount'),
      })),
      read<RouteRow>(PRODUCT_ROUTES, { productId: id }, (r) => ({
        lineageOres: r.get('lineageOres'), deliveredMinerals: r.get('deliveredMinerals'),
        chain: r.get('chain'), legs: r.get('legs'), hops: r.get('hops'),
      })),
      read<Plant>(PRODUCT_PLANTS, { productId: id }, (r) => ({
        operationId: r.get('operationId'), site: r.get('site'), country: r.get('country'),
        company: r.get('company'), capacity: r.get('capacity'),
      })),
      read<DirectoryRow>(OPERATION_DIRECTORY, {}, (r) => ({
        id: r.get('id'), type: r.get('type'), siteId: r.get('siteId'), siteName: r.get('siteName'),
        countryId: r.get('countryId'), country: r.get('country'),
        companyId: r.get('companyId'), company: r.get('company'),
      })),
      read<{ ores: Array<{ id: string; name: string }>; minerals: Array<{ id: string; name: string }> }>(
        ORE_AND_MINERAL_NAMES, {}, (r) => ({ ores: r.get('ores'), minerals: r.get('minerals') })
      ),
    ]);

    // Unknown product id is a 404, not an empty success — the UI needs to tell
    // "no such product" apart from "product with nothing traced".
    if (product.length === 0) {
      return NextResponse.json(
        { status: 'error', message: `No product with id "${id}".` },
        { status: 404 }
      );
    }

    const dir = new Map(directory.map((d) => [d.id, d]));
    const plantIds = new Set(plants.map((p) => p.operationId));
    const oreName = new Map((names[0]?.ores ?? []).map((o) => [o.id, o.name]));
    const mineralName = new Map((names[0]?.minerals ?? []).map((m) => [m.id, m.name]));

    // Fold the traced paths into a deduplicated graph. Done here rather than in
    // Cypher because it is bookkeeping over a result set, not traversal.
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();

    const routeSummaries: RouteSummary[] = [];

    for (const route of routes) {
      // The lineages this one route belongs to: every (delivered mineral, lineage
      // ore) pair. These keys match the composition rows exactly, which is what
      // lets a click on "Cobalt from Copper ore" light precisely its own routes.
      const routeLineages = route.lineageOres.flatMap((oreId) =>
        route.deliveredMinerals.map((mineralId) => `${mineralId}|${oreId}`)
      );

      route.chain.forEach((n) => {
        const meta = dir.get(n.id);
        const existing = nodes.get(n.id);
        if (existing) {
          for (const l of routeLineages) if (!existing.lineages.includes(l)) existing.lineages.push(l);
          return;
        }
        nodes.set(n.id, {
          id: n.id,
          type: n.type,
          stage: STAGE_RANK[n.type] ?? 0,
          site: meta?.siteName ?? n.id,
          label: meta?.siteName ?? n.id,
          country: meta?.country ?? 'Unknown',
          company: meta?.company ?? null,
          isOrigin: n.type === 'mining',
          isPlant: plantIds.has(n.id),
          capacity: n.capacity ?? null,
          status: n.status ?? null,
          lineages: [...routeLineages],
        });
      });

      route.legs.forEach((leg, i) => {
        const from = route.chain[i]?.id;
        const to = route.chain[i + 1]?.id;
        if (!from || !to) return;
        const key = `${from}|${to}|${leg.ores.join(',')}|${leg.minerals.join(',')}`;
        const existing = edges.get(key);
        if (existing) {
          for (const l of routeLineages) if (!existing.lineages.includes(l)) existing.lineages.push(l);
          return;
        }
        edges.set(key, {
          id: key, from, to,
          ores: leg.ores, minerals: leg.minerals, form: leg.form, tonnage: leg.tonnage,
          oreNames: leg.ores.map((o) => oreName.get(o) ?? o),
          mineralNames: leg.minerals.map((m) => mineralName.get(m) ?? m),
          lineages: [...routeLineages],
        });
      });

      // The same edge keys again, in path order, so hovering a route card can
      // light precisely its own links rather than the whole lineage.
      const edgeIds = route.legs
        .map((leg, i) => {
          const from = route.chain[i]?.id;
          const to = route.chain[i + 1]?.id;
          return from && to ? `${from}|${to}|${leg.ores.join(',')}|${leg.minerals.join(',')}` : null;
        })
        .filter((x): x is string => x !== null);

      routeSummaries.push({
        id: edgeIds.join('>>'),
        steps: route.chain.map((n) => ({ id: n.id, label: n.id, type: n.type })),
        edgeIds,
        lineages: routeLineages,
        hops: route.hops,
        deliveredTonnage: route.legs[route.legs.length - 1]?.tonnage ?? 0,
      });
    }

    // A site with two operations yields two nodes. Left alone they carry the
    // same label and the graph reads as a duplicate rather than as the two
    // process units it is - so only the ambiguous ones get qualified.
    const siteCounts = new Map<string, number>();
    for (const n of nodes.values()) siteCounts.set(n.site, (siteCounts.get(n.site) ?? 0) + 1);
    for (const n of nodes.values()) {
      if ((siteCounts.get(n.site) ?? 0) > 1) n.label = `${n.site} · ${n.type}`;
    }

    // Resolve step labels only now: a site with two operations was just
    // qualified above, so "Greenbushes" became "Greenbushes · concentration".
    for (const r of routeSummaries) {
      for (const step of r.steps) step.label = nodes.get(step.id)?.label ?? step.id;
    }

    return NextResponse.json({
      status: 'ok',
      productId: id,
      product: product[0],
      composition,
      plants,
      routes: routeSummaries,
      routeCount: routes.length,
      graph: { nodes: [...nodes.values()], edges: [...edges.values()] },
    });
  } catch (err) {
    const { status, message } = describeDbError(err);
    console.error(`[product] ${id}:`, err);
    return NextResponse.json({ status: 'error', message }, { status });
  }
}
