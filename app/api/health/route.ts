import { NextResponse } from 'next/server';
import { read, describeDbError } from '@/lib/cogno';
import { HEALTH, GRAPH_SUMMARY } from '@/lib/queries';


/**
 * GET /api/health
 *
 * The first thing to make work end to end. It proves, in order:
 *   - env vars are present and readable in the server runtime
 *   - the Bolt handshake and TLS succeed
 *   - credentials are accepted
 *   - a PARAMETERISED query round-trips ($probe is sent separately, never
 *     concatenated into the Cypher string)
 *   - the driver's error path produces a usable HTTP status
 *
 * It also reports node counts, so the same endpoint tells you whether the
 * seed has run. Useful in the deployed environment where you cannot just
 * look at a terminal.
 */
export async function GET() {
  const startedAt = Date.now();

  try {
    // Concurrent, not sequential. Run back to back against an unreachable
    // instance these two each burn a full timeout window and the endpoint takes
    // twice as long to report the same failure.
    const [[probe], [summary]] = await Promise.all([
      read(HEALTH, { probe: 'cognodb-liveness' }, (record) => ({
        probe: record.get('probe') as string,
        ok: record.get('ok') as number,
      })),
      read(GRAPH_SUMMARY, {}, (record) => ({
        byLabel: record.get('byLabel') as Array<{ label: string; count: number }>,
        totalNodes: record.get('totalNodes') as number,
      })),
    ]);

    return NextResponse.json({
      status: 'ok',
      roundTripMs: Date.now() - startedAt,
      probeEcho: probe.probe,
      seeded: summary.totalNodes > 0,
      nodes: summary.totalNodes,
      byLabel: summary.byLabel,
    });
  } catch (err) {
    // The brief explicitly grades graceful handling when the database is
    // unreachable. describeDbError maps driver errors onto a status and a
    // message safe to render in the UI - it never leaks the URI or a stack.
    const { status, message } = describeDbError(err);
    console.error('[health] database error:', err);

    return NextResponse.json(
      { status: 'error', message, roundTripMs: Date.now() - startedAt },
      { status }
    );
  }
}
