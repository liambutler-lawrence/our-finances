import { ensureSchema, getD1, rows } from "../../../db/runtime";
import { requireApiUser } from "../../session";

export const dynamic = "force-dynamic";

const columns = [
  "transaction_id",
  "statement_id",
  "account",
  "institution",
  "transaction_date",
  "posted_date",
  "description",
  "amount",
  "currency",
  "transaction_type",
  "category",
  "category_confidence",
  "review_status",
  "fee",
  "balance",
  "quantity",
  "unit_price",
  "symbol",
  "external_id",
  "source_page",
  "source_line_start",
  "source_line_end",
  "raw_text",
  "notes",
] as const;

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET() {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  await ensureSchema();
  const data = await rows<Record<(typeof columns)[number], unknown>>(
    getD1().prepare(
      `SELECT
         t.id AS transaction_id, t.statement_id,
         a.label AS account, a.institution,
         t.transaction_date, t.posted_date, t.description,
         t.amount_text AS amount, t.currency, t.transaction_type,
         c.label AS category, t.category_confidence, t.review_status,
         t.fee_text AS fee, t.balance_text AS balance,
         t.quantity_text AS quantity, t.unit_price_text AS unit_price,
         t.symbol, t.external_id, t.source_page, t.source_line_start,
         t.source_line_end, t.raw_text, t.notes
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
       ORDER BY COALESCE(t.transaction_date, ''), t.id`,
    ),
  );
  const csv = [
    columns.join(","),
    ...data.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="our-finances-transactions.csv"',
      "cache-control": "no-store",
    },
  });
}
