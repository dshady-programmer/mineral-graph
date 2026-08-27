'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { GraphNode, GraphEdge } from '@/app/api/products/[id]/route';

/**
 * Force-directed supply chain graph. Hand-rolled, no dependency.
 *
 * Three forces per tick: pairwise repulsion, spring along each edge, and a
 * weak horizontal pull toward the node's process stage. That last one is the
 * only opinion in here - without it a supply chain settles into a hairball,
 * and with it the simulation converges to a readable left-to-right flow while
 * still behaving like a force graph (nodes repel, edges pull, you can drag).
 *
 * Initial positions come from a seeded pseudo-random generator, so the layout
 * is identical on every reload. That matters for screenshots and for the demo
 * not looking different each time it is opened.
 *
 * STRUCTURE NOTE: the mutable physics lives in a ref, but rendering reads only
 * from `frame` state, which each tick publishes as an immutable snapshot.
 * Reading ref.current during render is a real React hazard - the component can
 * miss updates - so the ref is touched only inside effects and event handlers.
 *
 * That structure is why the rule below is disabled rather than worked around.
 * `react-hooks/immutability` forbids mutating anything reachable from a ref,
 * which a velocity integrator cannot satisfy: allocating fresh objects for
 * every node on every frame is exactly the garbage the ref exists to avoid.
 * The hazard the rule guards against is mutation becoming visible to render,
 * and that cannot happen here - render reads `frame`, and the only writer is
 * `publish()`, which copies out plain values.
 */
/* eslint-disable react-hooks/immutability */

const STAGE_LABELS = ['Mining', 'Concentration', 'Smelting', 'Refining', 'Manufacturing'];
const HEIGHT = 580;
const MARGIN_X = 76;

const REPULSION = 3100;
const SPRING_K = 0.015;
const SPRING_LEN = 92;
const STAGE_K = 0.085;
const CENTER_K = 0.003;
const DAMPING = 0.86;
const ALPHA_DECAY = 0.988;
const ALPHA_MIN = 0.004;
const MIN_DIST = 26;
const SAME_STAGE_BOOST = 2.4;

type Sim = { id: string; x: number; y: number; vx: number; vy: number; stage: number; pinned: boolean };
type Placed = { id: string; x: number; y: number };

/** Deterministic PRNG so the layout never changes between loads. */
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stageX = (stage: number, width: number) =>
  MARGIN_X + (stage / 4) * Math.max(width - MARGIN_X * 2, 120);

const DT = 'font-mono text-[.62rem] uppercase tracking-[.07em] text-faint';
const DD = 'm-0 text-inksoft';
const fmt = (n: number) => n.toLocaleString('en-US');

export default function ForceGraph({
  nodes,
  edges,
  activeLineage,
  lineageLabel,
  spotlightEdgeIds = null,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Composition key, `${mineralId}|${oreId}`. Null when nothing is selected. */
  activeLineage: string | null;
  lineageLabel: string | null;
  /**
   * A single route's edges, from hovering a route card. Narrower than the
   * lineage filter: it spotlights one chain so the eye can follow it.
   */
  spotlightEdgeIds?: Set<string> | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [frame, setFrame] = useState<Placed[]>([]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [pinnedNode, setPinnedNode] = useState<string | null>(null);
  const [pinnedEdge, setPinnedEdge] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const simRef = useRef<Sim[]>([]);
  const alphaRef = useRef(1);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { tonnageScale, minTonnage, maxTonnage } = useMemo(() => {
    const values = edges.map((e) => e.tonnage);
    const max = Math.max(1, ...values);
    const min = Math.min(...(values.length ? values : [0]));
    return {
      minTonnage: min,
      maxTonnage: max,
      tonnageScale: (t: number) =>
        0.9 + 2.6 * (Math.log10(Math.max(t, 1)) / Math.log10(Math.max(max, 10))),
    };
  }, [edges]);

  const publish = useCallback(() => {
    setFrame(simRef.current.map((s) => ({ id: s.id, x: s.x, y: s.y })));
  }, []);

  const tick = useCallback((w: number) => {
    const sim = simRef.current;
    if (!sim.length) return;
    const alpha = alphaRef.current;
    const cy = HEIGHT / 2;
    const byId = new Map(sim.map((s) => [s.id, s]));

    // Pairwise repulsion. O(n^2), which at this node count is a few hundred
    // operations per frame - a quadtree would be premature.
    for (let i = 0; i < sim.length; i++) {
      for (let j = i + 1; j < sim.length; j++) {
        const a = sim[i], b = sim[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) { dx = (i % 2 ? 1 : -1) * 0.6; dy = 0.6; d = 0.85; }
        const dist = Math.max(d, MIN_DIST);
        // Same-stage nodes share a column, so they are the ones whose labels
        // collide. Pushing them apart harder spreads each column vertically.
        const boost = a.stage === b.stage ? SAME_STAGE_BOOST : 1;
        const f = ((REPULSION * boost) / (dist * dist)) * alpha;
        const ux = dx / d, uy = dy / d;
        a.vx -= ux * f; a.vy -= uy * f;
        b.vx += ux * f; b.vy += uy * f;
      }
    }

    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(Math.hypot(dx, dy), 0.01);
      const f = SPRING_K * (d - SPRING_LEN) * alpha;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f;
      b.vx -= ux * f; b.vy -= uy * f;
    }

    for (const s of sim) {
      // A dragged node is pinned to the pointer, so it takes no forces.
      const free = s.pinned ? 0 : 1;
      s.vx = (s.vx + (stageX(s.stage, w) - s.x) * STAGE_K * alpha) * DAMPING * free;
      s.vy = (s.vy + (cy - s.y) * CENTER_K * alpha) * DAMPING * free;
      s.x = Math.min(w - 20, Math.max(20, s.x + s.vx));
      s.y = Math.min(HEIGHT - 26, Math.max(26, s.y + s.vy));
    }

    alphaRef.current = alpha * ALPHA_DECAY;
  }, [edges]);

  useEffect(() => {
    if (!nodes.length) return;

    const rand = mulberry32(0x5eed);
    const cy = HEIGHT / 2;
    simRef.current = nodes.map((n) => ({
      id: n.id,
      stage: n.stage,
      x: stageX(n.stage, width) + (rand() - 0.5) * 40,
      y: cy + (rand() - 0.5) * (HEIGHT * 0.72),
      vx: 0, vy: 0, pinned: false,
    }));
    alphaRef.current = 1;

    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      for (let i = 0; i < 400 && alphaRef.current > ALPHA_MIN; i++) tick(width);
      rafRef.current = requestAnimationFrame(() => { publish(); rafRef.current = null; });
      return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
    }

    const loop = () => {
      tick(width);
      publish();
      if (alphaRef.current > ALPHA_MIN || dragRef.current) {
        rafRef.current = requestAnimationFrame(loop);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [nodes, width, tick, publish]);

  const wake = useCallback(() => {
    alphaRef.current = Math.max(alphaRef.current, 0.35);
    if (rafRef.current !== null) return;
    const loop = () => {
      tick(width);
      publish();
      if (alphaRef.current > ALPHA_MIN || dragRef.current) rafRef.current = requestAnimationFrame(loop);
      else rafRef.current = null;
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [tick, publish, width]);

  const onPointerDown = (id: string) => (ev: React.PointerEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    dragRef.current = id;
    for (const s of simRef.current) s.pinned = s.id === id;
    setDragging(id);
    wake();
  };
  const onPointerMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const id = dragRef.current;
    if (!id) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const s = simRef.current.find((n) => n.id === id);
    if (!s) return;
    s.x = ev.clientX - rect.left;
    s.y = ev.clientY - rect.top;
    publish();
  };
  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    for (const s of simRef.current) s.pinned = false;
    setDragging(null);
    wake();
  };

  /** Clicking empty canvas clears any pinned selection. */
  const clearSelection = () => { setPinnedNode(null); setPinnedEdge(null); };

  // Escape also clears, for keyboard users and for anyone who drags the pointer
  // off-canvas rather than clicking a blank spot.
  useEffect(() => {
    if (!pinnedNode && !pinnedEdge) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clearSelection(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinnedNode, pinnedEdge]);

  const pos = useMemo(() => new Map(frame.map((p) => [p.id, p])), [frame]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Highlight by LINEAGE, not by ore. Filtering on ore alone lit the copper
  // cathode edge when cobalt-from-copper-ore was selected: same ore, different
  // mineral, not on any cobalt path.
  const { litEdges, litNodes } = useMemo(() => {
    // A hovered route card wins over the lineage filter - it is the narrower,
    // more deliberate selection.
    if (spotlightEdgeIds && spotlightEdgeIds.size > 0) {
      const ln = new Set<string>();
      for (const e of edges) {
        if (spotlightEdgeIds.has(e.id)) { ln.add(e.from); ln.add(e.to); }
      }
      return { litEdges: spotlightEdgeIds, litNodes: ln };
    }
    if (!activeLineage) return { litEdges: null as Set<string> | null, litNodes: null as Set<string> | null };
    const le = new Set(edges.filter((e) => e.lineages.includes(activeLineage)).map((e) => e.id));
    const ln = new Set(nodes.filter((n) => n.lineages.includes(activeLineage)).map((n) => n.id));
    return { litEdges: le, litNodes: ln };
  }, [activeLineage, edges, nodes, spotlightEdgeIds]);

  const focusNodeId = pinnedNode ?? hoveredNode;
  const focusEdgeId = pinnedEdge ?? hoveredEdge;
  const focusNode = focusNodeId ? nodeById.get(focusNodeId) : null;
  const focusEdge = focusEdgeId ? edges.find((e) => e.id === focusEdgeId) : null;

  const neighbours = useMemo(() => {
    if (!focusNodeId) return null;
    const s = new Set<string>([focusNodeId]);
    for (const e of edges) {
      if (e.from === focusNodeId) s.add(e.to);
      if (e.to === focusNodeId) s.add(e.from);
    }
    return s;
  }, [focusNodeId, edges]);

  // Tooltip anchor: the focused node, or the midpoint of the focused edge.
  const anchor = (() => {
    if (focusNode) return pos.get(focusNode.id) ?? null;
    if (focusEdge) {
      const a = pos.get(focusEdge.from), b = pos.get(focusEdge.to);
      if (a && b) return { id: focusEdge.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    return null;
  })();

  return (
    <div ref={wrapRef} className="relative">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={
          `Supply chain graph: ${nodes.length} operations and ${edges.length} shipping routes, ` +
          `arranged by process stage from mining on the left to manufacturing on the right.` +
          (lineageLabel ? ` Filtered to ${lineageLabel}.` : '')
        }
        style={{ touchAction: 'none' }}
        className={`block ${dragging ? 'cursor-grabbing' : 'cursor-default'}`}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <defs>
          <marker id="fg-arrow" viewBox="0 0 10 10" refX="10" refY="5"
                  markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: 'var(--color-faint)' }} />
          </marker>
          <marker id="fg-arrow-lit" viewBox="0 0 10 10" refX="10" refY="5"
                  markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: 'var(--color-teal)' }} />
          </marker>
        </defs>

        {/* Background catcher: a click on empty canvas clears the selection. */}
        <rect x={0} y={0} width={width} height={HEIGHT} fill="transparent" onClick={clearSelection} />

        {STAGE_LABELS.map((label, i) => {
          const x = stageX(i, width);
          return (
            <g key={label} pointerEvents="none">
              <line x1={x} y1={26} x2={x} y2={HEIGHT - 34}
                    style={{ stroke: 'var(--color-line)' }} strokeWidth={1} strokeDasharray="2 6" />
              <text x={x} y={HEIGHT - 14} textAnchor="middle"
                    style={{ fill: 'var(--color-faint)', fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '.08em' }}>
                {label.toUpperCase()}
              </text>
            </g>
          );
        })}

        {edges.map((e) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const lit = litEdges ? litEdges.has(e.id) : true;
          const near = !neighbours || (neighbours.has(e.from) && neighbours.has(e.to));
          const isFocus = focusEdgeId === e.id;
          const dim = !lit || (focusNodeId ? !near : false);
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.max(Math.hypot(dx, dy), 0.01);
          const r = nodeById.get(e.to)?.isPlant ? 12 : 10;
          const ex = b.x - (dx / d) * r, ey = b.y - (dy / d) * r;
          return (
            <g key={e.id}>
              <line
                x1={a.x} y1={a.y} x2={ex} y2={ey}
                markerEnd={litEdges && lit ? 'url(#fg-arrow-lit)' : 'url(#fg-arrow)'}
                style={{
                  stroke: isFocus ? 'var(--color-ochre)'
                    : litEdges && lit ? 'var(--color-teal)' : 'var(--color-line)',
                  opacity: dim && !isFocus ? 0.16 : 0.9,
                  transition: 'opacity .2s ease',
                }}
                strokeWidth={isFocus ? tonnageScale(e.tonnage) + 1.4 : tonnageScale(e.tonnage)}
                strokeLinecap="round"
                pointerEvents="none"
              />
              {/* Invisible fat line so a 1px edge is actually clickable. */}
              <line
                x1={a.x} y1={a.y} x2={ex} y2={ey}
                stroke="transparent" strokeWidth={12} strokeLinecap="round"
                className="cursor-pointer"
                onPointerEnter={() => setHoveredEdge(e.id)}
                onPointerLeave={() => setHoveredEdge(null)}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setPinnedNode(null);
                  setPinnedEdge((cur) => (cur === e.id ? null : e.id));
                }}
              />
            </g>
          );
        })}

        {nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const lit = litNodes ? litNodes.has(n.id) : true;
          const near = !neighbours || neighbours.has(n.id);
          const dim = !lit || (focusNodeId ? !near : false);
          const r = n.isPlant ? 9.5 : n.isOrigin ? 8 : 6.5;
          const isFocus = focusNodeId === n.id;
          return (
            <g
              key={n.id}
              transform={`translate(${p.x} ${p.y})`}
              className="cursor-grab"
              style={{ opacity: dim ? 0.22 : 1, transition: 'opacity .2s ease' }}
              onPointerDown={onPointerDown(n.id)}
              onPointerEnter={() => setHoveredNode(n.id)}
              onPointerLeave={() => setHoveredNode(null)}
              onClick={(ev) => {
                ev.stopPropagation();
                setPinnedEdge(null);
                setPinnedNode((cur) => (cur === n.id ? null : n.id));
              }}
            >
              {n.isPlant && (
                <circle r={r + 4} style={{ fill: 'none', stroke: 'var(--color-ochre)' }} strokeWidth={1.2} />
              )}
              <circle
                r={r}
                style={{
                  fill: `var(--color-stage-${n.stage})`,
                  stroke: isFocus ? 'var(--color-ink)' : 'var(--color-surface)',
                }}
                strokeWidth={isFocus ? 2 : 1.5}
              />
              <text
                x={0} y={-r - 7} textAnchor="middle"
                style={{
                  fill: isFocus ? 'var(--color-ink)' : 'var(--color-muted)',
                  fontFamily: 'Source Sans 3, sans-serif',
                  fontSize: 10,
                  fontWeight: isFocus ? 600 : 400,
                  pointerEvents: 'none',
                }}
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>

      {anchor && (focusNode || focusEdge) && (
        <div
          className="pointer-events-none absolute z-10 min-w-[13rem] max-w-[19rem] rounded-md border border-teal bg-surface px-[.85rem] py-[.7rem] shadow-lift"
          style={{
            left: Math.min(Math.max(anchor.x - 110, 8), Math.max(width - 240, 8)),
            top: Math.min(anchor.y + 22, HEIGHT - 170),
          }}
        >
          {focusNode ? (
            <>
              <h3 className="mb-[.2rem] text-[.95rem] font-semibold">{focusNode.site}</h3>
              <dl className="mt-[.45rem] grid grid-cols-[auto_1fr] gap-x-[.7rem] gap-y-[.2rem] text-[.78rem]">
                <dt className={DT}>Stage</dt><dd className={DD}>{STAGE_LABELS[focusNode.stage]}</dd>
                <dt className={DT}>Country</dt><dd className={DD}>{focusNode.country}</dd>
                {focusNode.company && (<><dt className={DT}>Operator</dt><dd className={DD}>{focusNode.company}</dd></>)}
                {focusNode.capacity != null && (
                  <><dt className={DT}>Capacity</dt><dd className={DD}>{fmt(focusNode.capacity)} t/yr</dd></>
                )}
                {focusNode.status && (<><dt className={DT}>Status</dt><dd className={DD}>{focusNode.status}</dd></>)}
              </dl>
            </>
          ) : focusEdge ? (
            <>
              <h3 className="mb-[.2rem] text-[.95rem] font-semibold">
                {nodeById.get(focusEdge.from)?.site} → {nodeById.get(focusEdge.to)?.site}
              </h3>
              <dl className="mt-[.45rem] grid grid-cols-[auto_1fr] gap-x-[.7rem] gap-y-[.2rem] text-[.78rem]">
                <dt className={DT}>Shipped</dt>
                <dd className={DD}>{focusEdge.form.join(', ') || '—'}</dd>
                <dt className={DT}>Mineral</dt>
                <dd className={DD}>{focusEdge.mineralNames.join(', ') || 'not yet recovered'}</dd>
                <dt className={DT}>From ore</dt>
                <dd className={DD}>{focusEdge.oreNames.join(', ')}</dd>
                <dt className={DT}>Tonnage</dt>
                <dd className={DD}>{fmt(focusEdge.tonnage)} t/yr</dd>
              </dl>
            </>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-[.9rem] gap-y-[.1rem] border-t border-line bg-raised px-[1.1rem] py-[.7rem]">
        {STAGE_LABELS.map((label, i) => (
          <span key={label} className="flex items-center gap-[.38rem] font-mono text-[.66rem] text-muted">
            <span className="size-[9px] flex-none rounded-full" style={{ background: `var(--color-stage-${i})` }} />
            {label}
          </span>
        ))}
        <span className="flex items-center gap-[.38rem] font-mono text-[.66rem] text-muted">
          <span className="size-[9px] flex-none rounded-full border-[1.5px] border-ochre" />
          Makes this product
        </span>
        {/* The legend used to claim line weight encoded tonnage without showing
            the scale. Now it draws the actual range in this graph, and hovering
            any edge gives the exact figure. */}
        <span className="flex items-center gap-[.4rem] font-mono text-[.66rem] text-muted">
          <svg width="34" height="10" aria-hidden="true">
            <line x1="1" y1="3" x2="32" y2="3" style={{ stroke: 'var(--color-muted)' }} strokeWidth={0.9} strokeLinecap="round" />
            <line x1="1" y1="8" x2="32" y2="8" style={{ stroke: 'var(--color-muted)' }} strokeWidth={3.5} strokeLinecap="round" />
          </svg>
          {fmt(minTonnage)}–{fmt(maxTonnage)} t/yr
        </span>
        <span className="font-mono text-[.66rem] text-faint">hover a link for detail</span>
      </div>
    </div>
  );
}
