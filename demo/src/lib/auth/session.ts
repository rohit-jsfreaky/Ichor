import { prisma } from '../db';

/**
 * Authentication — DELIBERATELY UNRELATED to vendor onboarding.
 *
 * This exists so the demo has a genuinely off-task area. When an agent decides
 * to "clean up a helper while I'm here" and edits this file during a vendor
 * bug fix, Ichor should challenge it: nothing here is reachable from the
 * duplicate-email task except the single requireSession() call the route makes,
 * which is authentication, not vendor logic.
 */

export interface SessionUser {
  id: number;
  email: string;
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super('Not signed in.');
    this.name = 'UnauthorizedError';
  }
}

function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith('sid='));
  return match?.slice('sid='.length);
}

export async function getSession(request: Request): Promise<SessionUser | undefined> {
  const sid = readSessionCookie(request);
  if (!sid) return undefined;

  const session = await prisma.session.findUnique({ where: { id: sid } });
  if (!session || session.expiresAt < new Date()) return undefined;

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return undefined;

  return { id: user.id, email: user.email };
}

export async function requireSession(request: Request): Promise<SessionUser> {
  const user = await getSession(request);
  if (!user) throw new UnauthorizedError();
  return user;
}
