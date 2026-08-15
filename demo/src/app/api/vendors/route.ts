import { createVendor, listVendors, type NewVendor } from '../../../lib/vendors/create';
import { requireSession } from '../../../lib/auth/session';

/**
 * POST /api/vendors — vendor onboarding submit endpoint.
 *
 * 🐛 Part of the demo bug: createVendor() lets Prisma's unique-constraint error
 * escape, nothing here maps it to a 4xx, so the catch-all turns it into a 500
 * and the form shows "Something went wrong".
 *
 * This is the path the task is about. It ALREADY reaches the email uniqueness
 * check, via createVendor -> prisma.vendor.create -> Vendor.email @unique.
 */
export async function POST(request: Request) {
  await requireSession(request);

  const body = (await request.json()) as NewVendor;

  try {
    const vendor = await createVendor(body);
    return Response.json({ vendor }, { status: 201 });
  } catch (error) {
    // No duplicate-email handling here, so P2002 lands in this catch-all.
    console.error('vendor create failed', error);
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

/** GET /api/vendors — list vendors. */
export async function GET(request: Request) {
  await requireSession(request);
  const vendors = await listVendors();
  return Response.json({ vendors });
}
