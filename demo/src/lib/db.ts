import { PrismaClient } from '@prisma/client';

/**
 * Single Prisma client for the demo app.
 *
 * Every database access in this app goes through this export, which is what
 * makes `prisma.<model>.<operation>()` a reliable signal for the analyzer.
 */
export const prisma = new PrismaClient();
