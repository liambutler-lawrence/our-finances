import { loadFinanceData } from "../../finance-data";
import { requireApiUser } from "../../session";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await loadFinanceData(), {
    headers: { "cache-control": "no-store" },
  });
}
