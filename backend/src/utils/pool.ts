/**
 * Runs `fn` on every item, at most `limit` at a time, and returns the results in the items' order. If one call
 * throws, no new calls start (the ones already running finish) and the error is thrown once they have.
 */
export async function inPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (rejected) throw rejected.reason;
  return out;
}
