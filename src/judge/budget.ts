/**
 * Judge cost control.
 *
 * Graph first, LLM second. Obvious cases must never reach a model — that is both
 * correctness and cost. These caps are the backstop for when something does go
 * wrong: a loop that calls the Judge on every edit should run out of budget, not
 * out of credit.
 *
 * Counters live in the task state so they survive across hook invocations, each
 * of which is a separate process.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stateDir } from '../state.js';

export interface JudgeBudget {
  /** Judge calls allowed for the whole task. */
  perTask: number;
  /** Judge calls allowed for one file. Stops an argument looping. */
  perFile: number;
}

export const DEFAULT_BUDGET: JudgeBudget = {
  perTask: Number(process.env.ICHOR_JUDGE_MAX_PER_TASK ?? 25),
  perFile: Number(process.env.ICHOR_JUDGE_MAX_PER_FILE ?? 2),
};

interface Ledger {
  total: number;
  byFile: Record<string, number>;
}

function ledgerPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), 'judge.json');
}

function readLedger(repoRoot: string): Ledger {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(repoRoot), 'utf8')) as Ledger;
  } catch {
    return { total: 0, byFile: {} };
  }
}

function writeLedger(repoRoot: string, ledger: Ledger): void {
  try {
    fs.mkdirSync(stateDir(repoRoot), { recursive: true });
    fs.writeFileSync(ledgerPath(repoRoot), JSON.stringify(ledger, null, 2), 'utf8');
  } catch {
    // Accounting must never break the decision.
  }
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  spentOnTask: number;
  spentOnFile: number;
}

export function checkBudget(
  repoRoot: string,
  file: string,
  budget: JudgeBudget = DEFAULT_BUDGET,
): BudgetCheck {
  const ledger = readLedger(repoRoot);
  const spentOnFile = ledger.byFile[file] ?? 0;

  if (ledger.total >= budget.perTask) {
    return {
      allowed: false,
      reason: `Judge budget for this task is spent (${ledger.total}/${budget.perTask}). Falling back to the graph-only verdict.`,
      spentOnTask: ledger.total,
      spentOnFile,
    };
  }
  if (spentOnFile >= budget.perFile) {
    return {
      allowed: false,
      reason: `Already consulted the Judge ${spentOnFile}× about ${file}. Further argument is a decision for the developer.`,
      spentOnTask: ledger.total,
      spentOnFile,
    };
  }
  return { allowed: true, spentOnTask: ledger.total, spentOnFile };
}

export function recordJudgeCall(repoRoot: string, file: string): void {
  const ledger = readLedger(repoRoot);
  ledger.total += 1;
  ledger.byFile[file] = (ledger.byFile[file] ?? 0) + 1;
  writeLedger(repoRoot, ledger);
}

export function resetBudget(repoRoot: string): void {
  writeLedger(repoRoot, { total: 0, byFile: {} });
}
