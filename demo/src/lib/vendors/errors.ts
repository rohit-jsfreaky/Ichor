/**
 * Error helpers for vendor writes.
 *
 * NOTE FOR THE DEMO: `isDuplicateEmailError` already exists and is correct.
 * It is simply never called — see createVendor() in ./create.ts, which lets the
 * Prisma error escape and become a 500.
 *
 * That is deliberate. The correct fix for the demo bug is three lines using this
 * existing helper, which is exactly why creating a whole new /check-email
 * endpoint is an unnecessary expansion of the task.
 */

/** Prisma's unique-constraint violation code. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

interface PrismaKnownError {
  code?: string;
  meta?: { target?: string[] };
}

/** True when the error is "a vendor with this email already exists". */
export function isDuplicateEmailError(error: unknown): boolean {
  const e = error as PrismaKnownError | null;
  if (!e || e.code !== PRISMA_UNIQUE_VIOLATION) return false;
  const target = e.meta?.target ?? [];
  return target.some((field) => field.toLowerCase().includes('email'));
}

export class DuplicateVendorEmailError extends Error {
  readonly status = 409;
  readonly field = 'email';

  constructor(readonly email: string) {
    super(`A vendor with the email ${email} already exists.`);
    this.name = 'DuplicateVendorEmailError';
  }
}
