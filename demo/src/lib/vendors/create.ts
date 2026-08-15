import { prisma } from '../db';

export interface NewVendor {
  company: string;
  name: string;
  email: string;
  address?: string;
  phone?: string;
}

/**
 * Create a vendor.
 *
 * 🐛 THE DEMO BUG LIVES HERE.
 *
 * `Vendor.email` is `@unique`, so submitting an email that already exists makes
 * Prisma throw P2002. Nothing catches it, so it propagates out of the route
 * handler and the API returns a 500 with "Something went wrong".
 *
 * `isDuplicateEmailError` in ./errors.ts already knows how to recognise this
 * exact case — it is just never called. The fix is to catch here and throw
 * DuplicateVendorEmailError so the handler can answer 409.
 */
export async function createVendor(input: NewVendor) {
  const vendor = await prisma.vendor.create({
    data: {
      company: input.company,
      name: input.name,
      email: input.email,
      address: input.address,
      phone: input.phone,
    },
  });

  return vendor;
}

/** Look up a single vendor by id. */
export async function getVendor(id: number) {
  return prisma.vendor.findUnique({ where: { id } });
}

/** List vendors, newest first. */
export async function listVendors() {
  return prisma.vendor.findMany({ orderBy: { createdAt: 'desc' } });
}
