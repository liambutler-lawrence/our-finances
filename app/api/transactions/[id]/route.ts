import { ensureSchema, getD1 } from "../../../../db/runtime";
import { requireApiUser } from "../../../session";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json()) as {
    categoryId?: unknown;
    reviewStatus?: unknown;
  };
  if (typeof body.categoryId !== "string" || body.categoryId === "") {
    return Response.json({ error: "A category is required" }, { status: 400 });
  }
  const reviewStatus =
    body.reviewStatus === "reviewed" ? "reviewed" : "needs_review";
  await ensureSchema();
  const result = await getD1()
    .prepare(
      `UPDATE transactions
       SET category_id = ?, review_status = ?, reviewed_at = ?, reviewed_by = ?
       WHERE id = ?`,
    )
    .bind(
      body.categoryId,
      reviewStatus,
      new Date().toISOString(),
      user.email,
      id,
    )
    .run();
  if (!result.meta.changes) {
    return Response.json({ error: "Transaction not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
