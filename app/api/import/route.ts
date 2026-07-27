import { ensureSchema, getD1, rows, runBatch } from "../../../db/runtime";
import { requireApiUser } from "../../session";

export const dynamic = "force-dynamic";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as UnknownRecord;
}

function list(value: unknown, label: string): UnknownRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map(record);
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function optional(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

async function stableId(prefix: string, value: string) {
  const bytes = new TextEncoder().encode(value.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .slice(0, 10)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

function booleanInteger(value: unknown, fallback = true) {
  if (value === undefined || value === null) return fallback ? 1 : 0;
  return value === false || value === 0 ? 0 : 1;
}

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const payload = record(await request.json());
    await ensureSchema();
    if (payload.kind === "our-finances-legacy-v1") {
      const imported = await importLegacy(payload, user.email);
      return Response.json({ imported });
    }
    if (payload.schema_version === "1.0.0" && payload.manifest) {
      const imported = await importStatement(payload, user.email);
      return Response.json({ imported });
    }
    return Response.json(
      { error: "Unsupported import bundle" },
      { status: 400 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return Response.json({ error: message }, { status: 400 });
  }
}

async function importLegacy(payload: UnknownRecord, email: string) {
  const db = getD1();
  const now = new Date().toISOString();
  const accounts = list(payload.accounts, "accounts");
  const categories = list(payload.categories, "categories");
  const aggregates = list(payload.aggregates, "aggregates");
  const balances = list(payload.balances, "balances");
  const prices = list(payload.prices, "prices");
  const issues = list(payload.issues, "issues");
  const statements = [
    ...accounts.map((item) =>
      db
        .prepare(
          `INSERT INTO accounts
            (id, label, institution, owner_label, account_type, currency, asset_symbol, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             label=excluded.label, institution=excluded.institution,
             owner_label=excluded.owner_label, account_type=excluded.account_type,
             currency=excluded.currency, asset_symbol=excluded.asset_symbol,
             active=excluded.active`,
        )
        .bind(
          required(item.id, "account.id"),
          required(item.label, "account.label"),
          optional(item.institution),
          optional(item.owner_label),
          optional(item.account_type),
          required(item.currency, "account.currency"),
          optional(item.asset_symbol),
          booleanInteger(item.active),
          optional(item.created_at) ?? now,
        ),
    ),
    ...categories.map((item) =>
      db
        .prepare(
          `INSERT INTO categories (id, label, group_name, sort_order, active)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             label=excluded.label, group_name=excluded.group_name,
             sort_order=excluded.sort_order, active=excluded.active`,
        )
        .bind(
          required(item.id, "category.id"),
          required(item.label, "category.label"),
          required(item.group_name, "category.group_name"),
          integer(item.sort_order),
          booleanInteger(item.active),
        ),
    ),
    ...aggregates.map((item) =>
      db
        .prepare(
          `INSERT INTO legacy_aggregates
            (id, month, kind, account_id, category_id, label, amount_text,
             currency, amount_mxn_text, amount_usd_text, source_ref, verification_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             month=excluded.month, kind=excluded.kind,
             account_id=excluded.account_id, category_id=excluded.category_id,
             label=excluded.label, amount_text=excluded.amount_text,
             currency=excluded.currency, amount_mxn_text=excluded.amount_mxn_text,
             amount_usd_text=excluded.amount_usd_text,
             source_ref=excluded.source_ref,
             verification_status=excluded.verification_status`,
        )
        .bind(
          required(item.id, "aggregate.id"),
          required(item.month, "aggregate.month"),
          required(item.kind, "aggregate.kind"),
          optional(item.account_id),
          optional(item.category_id),
          optional(item.label),
          optional(item.amount_text),
          optional(item.currency),
          optional(item.amount_mxn_text),
          optional(item.amount_usd_text),
          optional(item.source_ref),
          required(item.verification_status, "aggregate.verification_status"),
        ),
    ),
    ...balances.map((item) =>
      db
        .prepare(
          `INSERT INTO balance_snapshots
            (id, account_id, as_of_date, balance_text, currency, source_ref, verification_status)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             account_id=excluded.account_id, as_of_date=excluded.as_of_date,
             balance_text=excluded.balance_text, currency=excluded.currency,
             source_ref=excluded.source_ref,
             verification_status=excluded.verification_status`,
        )
        .bind(
          required(item.id, "balance.id"),
          required(item.account_id, "balance.account_id"),
          required(item.as_of_date, "balance.as_of_date"),
          required(item.balance_text, "balance.balance_text"),
          required(item.currency, "balance.currency"),
          optional(item.source_ref),
          required(item.verification_status, "balance.verification_status"),
        ),
    ),
    ...prices.map((item) =>
      db
        .prepare(
          `INSERT INTO prices
            (id, symbol, kind, quote_currency, value_text, updated_at, source_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             symbol=excluded.symbol, kind=excluded.kind,
             quote_currency=excluded.quote_currency, value_text=excluded.value_text,
             updated_at=excluded.updated_at, source_ref=excluded.source_ref`,
        )
        .bind(
          required(item.id, "price.id"),
          required(item.symbol, "price.symbol"),
          required(item.kind, "price.kind"),
          required(item.quote_currency, "price.quote_currency"),
          required(item.value_text, "price.value_text"),
          optional(item.updated_at),
          optional(item.source_ref),
        ),
    ),
    ...issues.map((item) =>
      db
        .prepare(
          `INSERT INTO data_issues
            (id, severity, month, account_id, title, detail, status, source_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             severity=excluded.severity, month=excluded.month,
             account_id=excluded.account_id, title=excluded.title,
             detail=excluded.detail, status=excluded.status,
             source_ref=excluded.source_ref`,
        )
        .bind(
          required(item.id, "issue.id"),
          required(item.severity, "issue.severity"),
          optional(item.month),
          optional(item.account_id),
          required(item.title, "issue.title"),
          required(item.detail, "issue.detail"),
          required(item.status, "issue.status"),
          optional(item.source_ref),
          optional(item.created_at) ?? now,
        ),
    ),
  ];
  await runBatch(statements);
  const count = statements.length;
  await db
    .prepare(
      `INSERT INTO import_batches
        (id, kind, source_name, imported_at, imported_by, record_count)
       VALUES (?, 'legacy_workbook', ?, ?, ?, ?)`,
    )
    .bind(
      `batch_${crypto.randomUUID()}`,
      optional(payload.source_name) ?? "private workbook migration",
      now,
      email,
      count,
    )
    .run();
  return count;
}

async function importStatement(payload: UnknownRecord, email: string) {
  const db = getD1();
  const manifest = record(payload.manifest);
  const transactions = list(payload.transactions, "transactions");
  const sections = list(manifest.sections ?? [], "manifest.sections");
  const transactionCount = integer(manifest.transaction_count, -1);
  if (transactionCount !== transactions.length) {
    throw new Error("Manifest transaction count does not match bundle rows");
  }

  const sourceSha = required(manifest.source_sha256, "manifest.source_sha256");
  const statementId = required(manifest.statement_id, "manifest.statement_id");
  const now = new Date().toISOString();
  const existingCategories = await rows<{ id: string; label: string }>(
    db.prepare("SELECT id, label FROM categories"),
  );
  const categoryIds = new Map(
    existingCategories.map((item) => [item.label.toLowerCase(), item.id]),
  );
  const accountRows = new Map<string, UnknownRecord>();
  for (const item of sections) {
    accountRows.set(required(item.account_section_id, "section.account_section_id"), item);
  }
  for (const transaction of transactions) {
    const id = required(
      transaction.account_section_id,
      "transaction.account_section_id",
    );
    if (!accountRows.has(id)) accountRows.set(id, transaction);
  }

  const statements: D1PreparedStatement[] = [];
  for (const [id, item] of accountRows) {
    statements.push(
      db
        .prepare(
          `INSERT INTO accounts
            (id, label, institution, account_type, currency, active, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             label=excluded.label, institution=excluded.institution,
             account_type=excluded.account_type, currency=excluded.currency`,
        )
        .bind(
          id,
          required(item.account_name, "account.account_name"),
          optional(item.institution) ?? optional(manifest.detected_institution),
          optional(item.account_type) ?? "unknown",
          required(item.currency, "account.currency"),
          now,
        ),
    );
  }

  for (const transaction of transactions) {
    const categoryLabel =
      optional(transaction.category)?.trim() || "Needs review";
    const key = categoryLabel.toLowerCase();
    if (!categoryIds.has(key)) {
      const id = await stableId("cat", categoryLabel);
      categoryIds.set(key, id);
      statements.push(
        db
          .prepare(
            `INSERT INTO categories (id, label, group_name, sort_order, active)
             VALUES (?, ?, 'review', 900, 1)
             ON CONFLICT(id) DO UPDATE SET label=excluded.label`,
          )
          .bind(id, categoryLabel),
      );
    }
  }

  const sectionStatuses = sections.map((item) => optional(item.status));
  const reconciliationStatus = sectionStatuses.includes("fail")
    ? "fail"
    : sectionStatuses.includes("market_value_review")
      ? "market_value_review"
      : sectionStatuses.every((status) => status === "pass")
        ? "pass"
        : "insufficient_balance_data";
  const firstSection = sections[0] ?? transactions[0] ?? {};
  statements.push(
    db
      .prepare(
        `INSERT INTO statements
          (id, source_sha256, source_basename, institution, account_id,
           period_start, period_end, currency, opening_balance, closing_balance,
           reconciliation_status, validation_state, transaction_count,
           unparsed_money_line_count, imported_at, imported_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_basename=excluded.source_basename,
           reconciliation_status=excluded.reconciliation_status,
           validation_state=excluded.validation_state,
           transaction_count=excluded.transaction_count,
           unparsed_money_line_count=excluded.unparsed_money_line_count,
           imported_at=excluded.imported_at, imported_by=excluded.imported_by`,
      )
      .bind(
        statementId,
        sourceSha,
        required(manifest.source_basename, "manifest.source_basename"),
        optional(manifest.detected_institution),
        optional(firstSection.account_section_id),
        optional(firstSection.period_start),
        optional(firstSection.period_end),
        optional(firstSection.currency),
        optional(firstSection.opening_balance),
        optional(firstSection.closing_balance),
        reconciliationStatus,
        required(manifest.validation_state, "manifest.validation_state"),
        transactions.length,
        integer(manifest.unparsed_money_line_count),
        now,
        email,
      ),
  );

  for (const item of transactions) {
    const categoryLabel = optional(item.category)?.trim() || "Needs review";
    statements.push(
      db
        .prepare(
          `INSERT INTO transactions
            (id, statement_id, account_id, category_id, transaction_date,
             posted_date, description, amount_text, currency, transaction_type,
             category_confidence, categorization_source, review_status, fee_text,
             balance_text, quantity_text, unit_price_text, symbol, external_id,
             source_page, source_line_start, source_line_end, raw_text, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             category_id=excluded.category_id,
             category_confidence=excluded.category_confidence,
             categorization_source=excluded.categorization_source,
             review_status=excluded.review_status, notes=excluded.notes`,
        )
        .bind(
          required(item.transaction_id, "transaction.transaction_id"),
          statementId,
          required(item.account_section_id, "transaction.account_section_id"),
          categoryIds.get(categoryLabel.toLowerCase())!,
          optional(item.transaction_date),
          optional(item.posted_date),
          required(item.description, "transaction.description"),
          required(item.amount, "transaction.amount"),
          required(item.currency, "transaction.currency"),
          optional(item.transaction_type) ?? "unknown",
          optional(item.category_confidence),
          optional(item.categorization_source),
          optional(item.review_status) ?? "needs_review",
          optional(item.fee),
          optional(item.balance),
          optional(item.quantity),
          optional(item.unit_price),
          optional(item.symbol),
          optional(item.external_id),
          integer(item.source_page) || null,
          integer(item.source_line_start) || null,
          integer(item.source_line_end) || null,
          required(item.raw_text, "transaction.raw_text"),
          optional(item.notes),
        ),
    );
  }
  await runBatch(statements);
  await db
    .prepare(
      `INSERT INTO import_batches
        (id, kind, source_name, imported_at, imported_by, record_count)
       VALUES (?, 'statement', ?, ?, ?, ?)`,
    )
    .bind(
      `batch_${crypto.randomUUID()}`,
      required(manifest.source_basename, "manifest.source_basename"),
      now,
      email,
      transactions.length,
    )
    .run();
  return statements.length;
}
