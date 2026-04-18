export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const { retries = 4, baseDelayMs = 1500, label = "request" } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient =
        /503|UNAVAILABLE|overloaded|high demand|429|RESOURCE_EXHAUSTED|ECONNRESET|fetch failed/i.test(
          msg,
        );
      if (!transient || attempt === retries) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[retry] ${label}: attempt ${attempt + 1} failed, waiting ${delay}ms. ${msg}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
