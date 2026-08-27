import { NextResponse } from 'next/server';
import { read, describeDbError } from '@/lib/cogno';
import { COUNTRY_DISRUPTION, COUNTRY_OPERATIONS } from '@/lib/queries';

// export const dynamic = 'force-dynamic';

type DisruptionRow = {
  productId: string;
  product: string;
  mineralId: string;
  mineral: string;
  symbol: string;
  totalRoutes: number;
  affectedRoutes: number;
};

export type Impact = DisruptionRow & {
  /**
   * severed  - every route for this mineral passes through the country.
   *            Production stops.
   * reduced  - some routes survive elsewhere. Production continues, thinner.
   * clear    - no route touches the country.
   */
  severity: 'severed' | 'reduced' | 'clear';
  share: number;
};

export type CountryOperation = {
  operationId: string;
  type: string;
  site: string;
  company: string | null;
};

/**
 * GET /api/risk/:countryId
 *
 * "This country restricts exports - what stops?"
 *
 * The severity split is the whole point. A binary affected/not-affected answer
 * would be misleading here: cobalt reaches the NMC pack from two independent
 * lineages, Congolese copper ore and Indonesian nickel laterite, so a Congo
 * restriction thins that supply rather than cutting it. Copper reaches the same
 * plant from exactly one refinery, in Congo - that one stops dead. Same
 * country, same product, two completely different outcomes.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ countryId: string }> }
) {
  const { countryId } = await params;
  const id = decodeURIComponent(countryId);

  if (!id || !id.startsWith('ctry:')) {
    return NextResponse.json(
      { status: 'error', message: 'Country id must look like "ctry:cd".' },
      { status: 400 }
    );
  }

  try {
    const [rows, operations] = await Promise.all([
      read<DisruptionRow>(COUNTRY_DISRUPTION, { countryId: id }, (r) => ({
        productId: r.get('productId'),
        product: r.get('product'),
        mineralId: r.get('mineralId'),
        mineral: r.get('mineral'),
        symbol: r.get('symbol'),
        totalRoutes: r.get('totalRoutes'),
        affectedRoutes: r.get('affectedRoutes'),
      })),
      read<CountryOperation>(COUNTRY_OPERATIONS, { countryId: id }, (r) => ({
        operationId: r.get('operationId'),
        type: r.get('type'),
        site: r.get('site'),
        company: r.get('company'),
      })),
    ]);

    if (operations.length === 0) {
      return NextResponse.json(
        { status: 'error', message: `No operations in the graph for "${id}".` },
        { status: 404 }
      );
    }

    const impacts: Impact[] = rows.map((r) => ({
      ...r,
      share: r.totalRoutes > 0 ? r.affectedRoutes / r.totalRoutes : 0,
      severity:
        r.affectedRoutes === 0
          ? 'clear'
          : r.affectedRoutes === r.totalRoutes
            ? 'severed'
            : 'reduced',
    }));

    return NextResponse.json({
      status: 'ok',
      countryId: id,
      operations,
      impacts,
      summary: {
        severed: impacts.filter((i) => i.severity === 'severed').length,
        reduced: impacts.filter((i) => i.severity === 'reduced').length,
        clear: impacts.filter((i) => i.severity === 'clear').length,
      },
    });
  } catch (err) {
    const { status, message } = describeDbError(err);
    console.error(`[risk] ${id}:`, err);
    return NextResponse.json({ status: 'error', message }, { status });
  }
}
