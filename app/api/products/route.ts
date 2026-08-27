import { NextResponse } from 'next/server';
import { read, describeDbError } from '@/lib/cogno';
import { PRODUCTS_LIST } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export type ProductSummary = {
  id: string;
  name: string;
  category: string;
  description: string;
  madeIn: string[];
  plantCount: number;
};

/** GET /api/products — the landing list. */
export async function GET() {
  try {
    const products = await read<ProductSummary>(PRODUCTS_LIST, {}, (record) => ({
      id: record.get('id'),
      name: record.get('name'),
      category: record.get('category'),
      description: record.get('description'),
      madeIn: record.get('madeIn') ?? [],
      plantCount: record.get('plantCount') ?? 0,
    }));

    return NextResponse.json({ status: 'ok', count: products.length, products });
  } catch (err) {
    const { status, message } = describeDbError(err);
    console.error('[products]', err);
    return NextResponse.json({ status: 'error', message }, { status });
  }
}
