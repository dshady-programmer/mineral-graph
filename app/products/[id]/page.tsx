'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import ForceGraph from '@/components/ForceGraph';
import { LoadingState, EmptyState, ErrorState, GraphSkeleton } from '@/components/States';
import type { Composition, GraphNode, GraphEdge, Plant, RouteSummary } from '@/app/api/products/[id]/route';

type Payload = {
  product: { id: string; name: string; category: string; description: string };
  composition: Composition[];
  plants: Plant[];
  routes: RouteSummary[];
  routeCount: number;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
};

type View =
  | { status: 'loading' }
  | { status: 'ready'; data: Payload }
  | { status: 'error'; message: string };

const STAGE_INDEX: Record<string, number> = {
  mining: 0, concentration: 1, smelting: 2, refining: 3, manufacturing: 4,
};

const PANEL = 'overflow-hidden rounded-md border border-line bg-surface shadow-card';
const PANEL_HEAD =
  'flex items-baseline justify-between gap-3 border-b border-line bg-raised px-[1.1rem] py-[.95rem]';
const PANEL_TITLE = 'font-mono text-[.78rem] font-semibold uppercase tracking-[.1em]';

export default function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  // Next.js 15+ delivers route params as a Promise. `use()` unwraps it in a
  // client component; destructuring it synchronously fails at runtime, not at
  // build, which makes it an easy one to ship broken.
  // Next.js already URL-decodes route params, and ':' needs no encoding in a
  // path segment, so the id arrives usable as-is.
  const { id: productId } = use(params);

  const [view, setView] = useState<View>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [activeLineage, setActiveLineage] = useState<string | null>(null);
  const [hoveredRoute, setHoveredRoute] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/products/${productId}`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok || body.status === 'error') {
          setView({
            status: 'error',
            message: body.message ?? 'The server returned an unexpected response.',
          });
          return;
        }
        setView({ status: 'ready', data: body });
      } catch {
        if (!cancelled) {
          setView({
            status: 'error',
            message: 'Could not reach the server. Check your connection and try again.',
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [productId, reloadKey]);

  const retry = () => {
    setView({ status: 'loading' });
    setReloadKey((k) => k + 1);
  };

  const data = view.status === 'ready' ? view.data : null;
  const active =
    data?.composition.find((c) => `${c.mineralId}|${c.oreId}` === activeLineage) ?? null;

  // A lineage's routes are distinct PATHS, and paths overlap heavily - 15
  // cobalt routes run over only 9 links. Showing both stops the header
  // implying you can count the routes on screen.
  const litLinkCount = activeLineage
    ? (data?.graph.edges.filter((e) => e.lineages.includes(activeLineage)).length ?? 0)
    : 0;

  // The selected lineage's routes, grouped by where they start. Grouping by
  // origin is what makes "3 origins" and "15 routes" legible: three groups,
  // fifteen chains inside them.
  const lineageRoutes = activeLineage
    ? (data?.routes.filter((r) => r.lineages.includes(activeLineage)) ?? [])
    : [];

  const routesByOrigin = lineageRoutes.reduce<Map<string, RouteSummary[]>>((acc, r) => {
    const origin = r.steps[0]?.label ?? 'Unknown';
    const list = acc.get(origin);
    if (list) list.push(r); else acc.set(origin, [r]);
    return acc;
  }, new Map());

  const spotlight = hoveredRoute
    ? new Set(lineageRoutes.find((r) => r.id === hoveredRoute)?.edgeIds ?? [])
    : null;

  return (
    <main>
      <Link
        href="/"
        className="mb-[1.1rem] inline-flex items-center gap-[.4rem] font-mono text-[.72rem] text-muted transition-colors hover:text-teal"
      >
        ← All products
      </Link>

      {view.status === 'error' && <ErrorState message={view.message} onRetry={retry} />}

      {view.status === 'loading' && (
        <>
          <div className="mb-8 max-w-[46rem]">
            <div className="skeleton mb-[.6rem] h-8 w-[18rem]" />
            <div className="skeleton mb-[.6rem] h-4 w-[28rem]" />
          </div>
          <div className="grid items-start gap-5 [grid-template-columns:minmax(0,1fr)] xl:[grid-template-columns:23rem_minmax(0,1fr)]">
            <div className={PANEL}><LoadingState label="Loading composition" rows={6} /></div>
            <div className={PANEL}><GraphSkeleton /></div>
          </div>
        </>
      )}

      {data && (
        <>
          <div className="mb-8 max-w-[46rem]">
            <p className="mb-[.8rem] font-mono text-[.68rem] uppercase tracking-[.14em] text-teal">
              {data.product.category}
            </p>
            <h1 className="mb-[.55rem] text-[clamp(1.7rem,3.8vw,2.35rem)] font-bold">
              {data.product.name}
            </h1>
            <p className="m-0 text-muted">{data.product.description}</p>
          </div>

          <div className="grid items-start gap-5 [grid-template-columns:minmax(0,1fr)] xl:[grid-template-columns:23rem_minmax(0,1fr)]">
            <div className="flex flex-col gap-5">
              <section className={PANEL}>
                <div className={PANEL_HEAD}>
                  <h2 className={PANEL_TITLE}>Composition</h2>
                  <span className="font-mono text-[.72rem] text-faint">
                    {data.composition.length} lineage{data.composition.length === 1 ? '' : 's'}
                  </span>
                </div>

                {data.composition.length === 0 ? (
                  <EmptyState
                    title="No traced routes"
                    detail="Nothing in the graph reaches this product from a mining operation. Either its supply chain has not been seeded, or every route exceeds the traversal depth."
                  />
                ) : (
                  <div className="flex flex-col">
                    {data.composition.map((c) => {
                      const key = `${c.mineralId}|${c.oreId}`;
                      const on = activeLineage === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setActiveLineage(on ? null : key)}
                          className={[
                            'flex w-full cursor-pointer flex-col gap-[.45rem] border-b border-l-[3px] border-b-linesoft px-[1.1rem] py-[.85rem] text-left transition-colors last:border-b-0',
                            on ? 'border-l-teal bg-tealwash' : 'border-l-transparent hover:bg-sunk',
                          ].join(' ')}
                        >
                          <span className="flex items-center gap-[.55rem]">
                            <span className="rounded-[3px] border border-teal bg-tealwash px-[.42rem] py-[.16rem] font-mono text-[.74rem] font-semibold text-tealdeep">
                              {c.symbol}
                            </span>
                            <span className="text-[.97rem] font-semibold">{c.mineral}</span>
                            <span
                              className={[
                                'ml-auto rounded-[3px] px-[.4rem] py-[.14rem] font-mono text-[.62rem] uppercase tracking-[.08em]',
                                c.role === 'byproduct'
                                  ? 'bg-ochrewash text-ochre'
                                  : 'bg-sunk text-muted',
                              ].join(' ')}
                            >
                              {c.role}
                            </span>
                          </span>
                          <span className="text-[.86rem] text-muted">
                            from <strong className="font-semibold text-inksoft">{c.ore}</strong>{' '}
                            in {c.originCountries.join(', ')}
                          </span>
                          <span className="flex gap-[.9rem] font-mono text-[.68rem] text-faint">
                            <span>
                              {c.originSites.length} origin{c.originSites.length === 1 ? '' : 's'}
                            </span>
                            <span>{c.routeCount} route{c.routeCount === 1 ? '' : 's'}</span>
                            <span>{c.shortestHops} hop{c.shortestHops === 1 ? '' : 's'} min</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className={PANEL}>
                <div className={PANEL_HEAD}>
                  <h2 className={PANEL_TITLE}>Made at</h2>
                  <span className="font-mono text-[.72rem] text-faint">{data.plants.length}</span>
                </div>
                <div className="p-[1.1rem]">
                  {data.plants.length === 0 ? (
                    <p className="m-0 text-[.9rem] text-muted">
                      No manufacturing operation in the graph makes this product.
                    </p>
                  ) : (
                    <table className="w-full border-collapse text-[.88rem]">
                      <thead>
                        <tr>
                          {['Company', 'Plant', 'Country'].map((h) => (
                            <th
                              key={h}
                              className="pr-[.55rem] pb-2 text-left font-mono text-[.64rem] font-semibold uppercase tracking-[.08em] text-faint"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.plants.map((p) => (
                          <tr key={p.operationId}>
                            <td className="border-t border-linesoft py-[.45rem] pr-[.55rem]">
                              {p.company ?? '—'}
                            </td>
                            <td className="border-t border-linesoft py-[.45rem] pr-[.55rem]">
                              {p.site}
                            </td>
                            <td className="border-t border-linesoft py-[.45rem] pr-[.55rem]">
                              {p.country}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>
            </div>

            <section className={`${PANEL} relative`}>
              <div className={PANEL_HEAD}>
                <h2 className={PANEL_TITLE}>Supply network</h2>
                <span className="font-mono text-[.68rem] text-faint">
                  {active ? (
                    <>
                      {active.mineral} from {active.ore} · {active.routeCount} route
                      {active.routeCount === 1 ? '' : 's'} over {litLinkCount} link
                      {litLinkCount === 1 ? '' : 's'}{' '}
                      <button
                        type="button"
                        onClick={() => setActiveLineage(null)}
                        className="cursor-pointer border-none bg-transparent p-0 font-mono text-[.66rem] text-teal underline-offset-2 hover:underline"
                      >
                        clear
                      </button>
                    </>
                  ) : (
                    `${data.graph.nodes.length} operations · ${data.routeCount} traced routes · Hover on links and nodes for details`
                  )}
                </span>
              </div>

              {data.graph.nodes.length === 0 ? (
                <EmptyState
                  title="Nothing to draw"
                  detail="No shipping routes reach this product, so there is no network to render."
                />
              ) : (
                <ForceGraph
                    nodes={data.graph.nodes}
                    edges={data.graph.edges}
                    activeLineage={activeLineage}
                    lineageLabel={active ? `${active.mineral} from ${active.ore}` : null}
                    spotlightEdgeIds={spotlight}
                  />
              )}
            </section>

            {active && (
              <section className={`${PANEL} xl:col-span-2`}>
                <div className={PANEL_HEAD}>
                  <h2 className={PANEL_TITLE}>
                    Every route · {active.mineral} from {active.ore}
                  </h2>
                  <span className="font-mono text-[.72rem] text-faint">
                    {lineageRoutes.length} route{lineageRoutes.length === 1 ? '' : 's'} from{' '}
                    {routesByOrigin.size} origin{routesByOrigin.size === 1 ? '' : 's'} ·
                    hover to trace
                  </span>
                </div>

                {lineageRoutes.length === 0 ? (
                  <EmptyState
                    title="No routes for this lineage"
                    detail="Nothing in the graph carries this mineral from this ore to a plant that makes the product."
                  />
                ) : (
                  <div className="max-h-[30rem] overflow-y-auto">
                    {[...routesByOrigin.entries()].map(([origin, rs]) => (
                      <div key={origin}>
                        <div className="sticky top-0 z-[1] flex items-baseline justify-between gap-3 border-b border-linesoft bg-raised px-[1.1rem] py-[.45rem]">
                          <span className="font-mono text-[.68rem] font-semibold uppercase tracking-[.08em] text-inksoft">
                            from {origin}
                          </span>
                          <span className="font-mono text-[.66rem] text-faint">
                            {rs.length} route{rs.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        {rs
                          .slice()
                          .sort((a, b) => a.hops - b.hops)
                          .map((r) => (
                            <div
                              key={r.id}
                              onMouseEnter={() => setHoveredRoute(r.id)}
                              onMouseLeave={() => setHoveredRoute(null)}
                              className={[
                                'flex flex-wrap items-center gap-x-[.35rem] gap-y-[.3rem] border-b border-linesoft px-[1.1rem] py-[.6rem] transition-colors last:border-b-0',
                                hoveredRoute === r.id ? 'bg-tealwash' : 'hover:bg-sunk',
                              ].join(' ')}
                            >
                              {r.steps.map((step, i) => (
                                <span key={step.id} className="flex items-center gap-[.35rem]">
                                  {i > 0 && <span className="text-faint">→</span>}
                                  <span
                                    className="size-[7px] flex-none rounded-full"
                                    style={{ background: `var(--color-stage-${STAGE_INDEX[step.type] ?? 0})` }}
                                  />
                                  <span className="text-[.86rem]">{step.label}</span>
                                </span>
                              ))}
                              <span className="ml-auto flex-none font-mono text-[.66rem] tabular-nums text-faint">
                                {r.hops} hop{r.hops === 1 ? '' : 's'} ·{' '}
                                {r.deliveredTonnage.toLocaleString('en-US')} t/yr
                              </span>
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </main>
  );
}
