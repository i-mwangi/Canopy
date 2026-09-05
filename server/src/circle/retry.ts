/**
 * Retry for calls to Circle.
 *
 * Only transient failures are retried: a name resolution blip, a dropped connection, a
 * timeout, a rate limit, or a server-side error. A rejected request — bad parameters, a
 * malformed key, insufficient funds — is returned immediately, because repeating it would
 * fail the same way and hide the real cause.
 */

const TRANSIENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
  'ERR_NETWORK',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') return candidate.code;

  // Node wraps a DNS or socket failure inside the error the HTTP client throws.
  return candidate.cause ? codeOf(candidate.cause) : undefined;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.response?.status === 'number') return candidate.response.status;

  return undefined;
}

export function isTransient(error: unknown): boolean {
  const code = codeOf(error);
  if (code && TRANSIENT_CODES.has(code)) return true;

  const status = statusOf(error);
  return status === 429 || (status !== undefined && status >= 500);
}

export type RetryOptions = {
  /** Total attempts including the first. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
};

/**
 * Runs `operation`, retrying transient failures with exponential backoff.
 *
 * Safe for reads, and for writes that carry an idempotency key: Circle dedupes a replayed
 * request, so a lost response cannot become a second transfer.
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransient(error)) throw error;

      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const label = options.label ?? 'circle call';
      const reason = codeOf(error) ?? statusOf(error) ?? 'unknown';

      console.warn(`${label} failed (${reason}); retrying in ${delayMs}ms [${attempt}/${attempts - 1}]`);
      options.onRetry?.(attempt, error, delayMs);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
