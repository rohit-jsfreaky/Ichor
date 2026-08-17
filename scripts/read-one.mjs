/**
 * Read one repository and report `functions ms peakMB` on stdout.
 *
 * Run as a child of `scripts/read-test.ts`, one process per repository, so a
 * repo that runs out of memory reports its own failure rather than ending the
 * whole run — and so the peak is that repo's, not everything before it.
 *
 * Uses the compiled build, and never raises the heap: the point of the check is
 * that the default is enough.
 */

import { analyzeRepo } from '../dist/src/extract/analyze.js';

const started = Date.now();
const facts = analyzeRepo(process.argv[2]);
const peakMb = Math.round((process.resourceUsage().maxRSS * 1024) / 1e6);

console.log(`${facts.functions.length} ${Date.now() - started} ${peakMb}`);
