import { NextResponse } from 'next/server';
import { read, describeDbError } from '@/lib/cogno';
import { COUNTRIES_LIST, CHOKEPOINTS } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export type CountryOption = { id: string; name: string; operationCount: number };

export type Chokepoint = {
  operationId: string;
  type: string;
  site: string;
  country: string;
  company: string | null;
  routesThrough: number;
  totalRoutes: number;
};

/**
 * GET /api/risk
 *
 * The country-independent half of the risk view: which countries have
 * operations, and the chokepoint ranking across the whole graph.
 */
export async function GET() {
  try {
    const [countries, chokepoints] = await Promise.all([
      read<CountryOption>(COUNTRIES_LIST, {}, (r) => ({
        id: r.get('id'),
        name: r.get('name'),
        operationCount: r.get('operationCount'),
      })),
      read<Chokepoint>(CHOKEPOINTS, {}, (r) => ({
        operationId: r.get('operationId'),
        type: r.get('type'),
        site: r.get('site'),
        country: r.get('country'),
        company: r.get('company'),
        routesThrough: r.get('routesThrough'),
        totalRoutes: r.get('totalRoutes'),
      })),
    ]);

    return NextResponse.json({
      status: 'ok',
      countries,
      // Mining operations are always on their own paths and manufacturing
      // operations are always at the end of theirs, so neither is a chokepoint
      // in any interesting sense. The question is which INTERMEDIATE node
      // everything funnels through.
      chokepoints: chokepoints.filter(
        (c) => c.type !== 'mining' && c.type !== 'manufacturing'
      ),
    });
  } catch (err) {
    const { status, message } = describeDbError(err);
    console.error('[risk]', err);
    return NextResponse.json({ status: 'error', message }, { status });
  }
}
