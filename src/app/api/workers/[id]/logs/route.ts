import { withAdmin } from "@/lib/auth";
import { ok, parseId } from "@/lib/api";
import { helper } from "@/lib/system/host";

export const GET = withAdmin(async (_a, req, ctx: { params: Promise<{ id: string }> }) => {
  const id = parseId((await ctx.params).id);
  const lines = Math.min(1000, Math.max(10, Number(new URL(req.url).searchParams.get("lines")) || 200));
  try {
    const out = await helper(["logs", id, lines]);
    // never return the secret even if the proxy printed it
    return ok({ logs: out.replace(/\b[0-9a-f]{32}\b/gi, "<redacted>"), available: true });
  } catch (e) {
    return ok({ logs: "", available: false, error: (e as Error).message });
  }
});
