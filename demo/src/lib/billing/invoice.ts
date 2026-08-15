import { prisma } from '../db';

/**
 * Billing — DELIBERATELY UNRELATED to vendor onboarding.
 *
 * Note that Invoice does relate to Vendor in the schema, so this area is *near*
 * the task without being *part of* it. That makes it a better test than
 * something completely disconnected: a naive "is it anywhere near vendors?"
 * check would wave an edit here through, and it should not.
 */

export async function createInvoice(vendorId: number, amount: number) {
  return prisma.invoice.create({ data: { vendorId, amount } });
}

export async function listUnpaidInvoices() {
  return prisma.invoice.findMany({ where: { paid: false }, orderBy: { issuedAt: 'desc' } });
}

export async function markInvoicePaid(id: number) {
  return prisma.invoice.update({ where: { id }, data: { paid: true } });
}
