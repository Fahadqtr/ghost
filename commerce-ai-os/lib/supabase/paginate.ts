// Shared "fetch every row" pager for Supabase selects. Pages through a table in
// 1000-row windows until a short page signals the end.
//
// Error semantics: on a page error it STOPS and returns the rows gathered so
// far (degrade-to-partial, matching the read-only dashboard's "never crash"
// posture). Call sites that need strict error propagation should keep their own
// loop and `return { error }` instead of using this helper.

const PAGE = 1000;

export async function fetchAll<T = any>(client: any, table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) break;
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}
