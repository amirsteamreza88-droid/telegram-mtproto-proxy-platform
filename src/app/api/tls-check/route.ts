import { HttpError, withAdmin } from "@/lib/auth";
import { ok, readJson } from "@/lib/api";
import { validateTlsDomain } from "@/lib/workers";

export const POST = withAdmin(async (_a, req) => {
  const { domain } = await readJson<{ domain?: string }>(req);
  if (!domain) throw new HttpError(400, "domain required");
  return ok(await validateTlsDomain(String(domain).trim().toLowerCase()));
});
