/**
 * Minimal OpenRouter client.
 *
 * Only the Judge talks to a model, and only for INTENT. Structure always comes
 * from the compiler and the graph — nothing here may add a node, an edge or a
 * path.
 *
 * Deliberately fetch() and not an SDK: one endpoint, one request shape.
 */

export interface OpenRouterConfig {
  apiKey?: string;
  /** Tried in order. First to answer wins. */
  models: string[];
  timeoutMs: number;
}

export function judgeConfigFromEnv(): OpenRouterConfig {
  // Accept both spellings — ICHOR_* is the documented one, OPENROUTER_* is what
  // most people already have exported.
  const apiKey =
    process.env.ICHOR_OPENROUTER_KEY ??
    process.env.OPENROUTER_API_KEY ??
    process.env.OPENROUTER_KEY;

  const configured = process.env.ICHOR_JUDGE_MODEL ?? process.env.OPENROUTER_MODEL;

  return {
    apiKey,
    // Primary is chosen for resisting a confident but unsupported argument,
    // which is the Judge's actual job. The fallback is cheap and fast, so a
    // provider outage degrades quality rather than breaking the product.
    models: configured
      ? [configured, 'deepseek/deepseek-v4-flash']
      : ['openai/gpt-5-mini', 'deepseek/deepseek-v4-flash'],
    timeoutMs: Number(process.env.ICHOR_JUDGE_TIMEOUT_MS ?? 20_000),
  };
}

export function isJudgeAvailable(config: OpenRouterConfig): boolean {
  return Boolean(config.apiKey);
}

export interface CompletionResult {
  content: string;
  model: string;
}

const DEBUG = process.env.ICHOR_DEBUG === '1';

function debug(message: string): void {
  if (DEBUG) process.stderr.write(`[ichor judge] ${message}\n`);
}

/**
 * Ask the first model that answers.
 *
 * Returns undefined rather than throwing: a Judge failure must degrade to the
 * graph-only verdict, never break the edit.
 */
export async function complete(
  config: OpenRouterConfig,
  system: string,
  user: string,
): Promise<CompletionResult | undefined> {
  if (!config.apiKey) return undefined;

  for (const model of config.models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          // OpenRouter uses these for attribution on its dashboards.
          'http-referer': 'https://github.com/rohit-jsfreaky/ichor',
          'x-title': 'Ichor',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // Deterministic: the same evidence should give the same verdict, or
          // the developer cannot trust it.
          temperature: 0,
          // Generous on purpose. Reasoning models spend tokens THINKING before
          // they answer, and that spend counts against max_tokens. A tight cap
          // makes them stop mid-thought and return `content: null` with
          // finish_reason "length" — which looks exactly like an outage.
          // Observed with deepseek-v4-flash, which burned an entire 50-token
          // budget on chain-of-thought and never wrote a verdict.
          max_tokens: 4000,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        debug(`${model}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
        continue;
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      };
      const choice = payload.choices?.[0];
      const content = choice?.message?.content;

      if (typeof content === 'string' && content.trim()) return { content, model };

      // Empty content is a real failure mode, not an outage. Name it so the
      // next model is tried for a reason we can see.
      debug(`${model}: empty content (finish_reason=${choice?.finish_reason ?? 'unknown'})`);
    } catch (error) {
      debug(`${model}: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return undefined;
}
