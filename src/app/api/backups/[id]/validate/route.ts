import { HttpError, withAdmin } from "@/lib/auth";
import { ok, parseId } from "@/lib/api";
import { validateBackup } from "@/lib/backup";

export const POST = withAdmin(async (_a, _req, ctx: { params: Promise<{ id: string }> }) => {
  const id = parseId((await ctx.params).id);
  try {
    return ok({ valid: true, ...(await validateBackup(id)) });
  } catch (e) {
    throw new HttpError(422, `Backup invalid: ${(e as Error).message}`);
  }
});
