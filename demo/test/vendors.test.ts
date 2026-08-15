import { describe, it, expect } from 'vitest';
import { isDuplicateEmailError } from '../src/lib/vendors/errors';

/**
 * The existing vendor tests.
 *
 * Note what is here and what is not: the helper that recognises a duplicate
 * email is tested, but nothing tests that creating a duplicate vendor produces
 * a friendly error — because the code does not do that yet. Adding that test is
 * a legitimate, expected part of the demo task.
 */
describe('isDuplicateEmailError', () => {
  it('recognises a Prisma unique violation on email', () => {
    expect(isDuplicateEmailError({ code: 'P2002', meta: { target: ['email'] } })).toBe(true);
  });

  it('ignores other Prisma errors', () => {
    expect(isDuplicateEmailError({ code: 'P2025' })).toBe(false);
    expect(isDuplicateEmailError({ code: 'P2002', meta: { target: ['company'] } })).toBe(false);
  });

  it('ignores non-Prisma errors', () => {
    expect(isDuplicateEmailError(new Error('boom'))).toBe(false);
    expect(isDuplicateEmailError(null)).toBe(false);
  });
});
