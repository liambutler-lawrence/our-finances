import {
  emptyFinanceData,
  type AccountRow,
  type BalanceRow,
  type CategoryRow,
  type FinanceData,
  type IssueRow,
  type PriceRow,
  type StatementRow,
  type TransactionRow,
} from "./finance-data";
import { deriveLedgerData, transactionMonth } from "./derive-ledger.mjs";
import {
  createManualTransaction as createManualRecord,
  deleteManualTransaction as deleteManualRecord,
  updateManualTransaction as updateManualRecord,
} from "./manual-transactions.mjs";

type UnknownRecord = Record<string, unknown>;

const transactionColumns = [
  "transaction_id",
  "statement_id",
  "account",
  "institution",
  "transaction_date",
  "posted_date",
  "budget_month",
  "date_precision",
  "description",
  "amount",
  "source_amount",
  "currency",
  "source_kind",
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

function record(value: unknown, label = "value"): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function list(value: unknown, label: string): UnknownRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
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

function bool(value: unknown, fallback = true): boolean {
  if (value === undefined || value === null) return fallback;
  return value !== false && value !== 0;
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

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    merged.set(item.id, { ...merged.get(item.id), ...item });
  }
  return [...merged.values()];
}

export function normalizeFinanceData(value: unknown): FinanceData {
  if (!value) return structuredClone(emptyFinanceData);
  const source = record(value, "ledger");
  const data: FinanceData = {
    accounts: (Array.isArray(source.accounts) ? source.accounts : []) as AccountRow[],
    categories: (Array.isArray(source.categories)
      ? source.categories
      : []) as CategoryRow[],
    aggregates: (Array.isArray(source.aggregates)
      ? source.aggregates
      : []) as AggregateRow[],
    balances: (Array.isArray(source.balances)
      ? source.balances
      : []) as BalanceRow[],
    prices: (Array.isArray(source.prices) ? source.prices : []) as PriceRow[],
    statements: (Array.isArray(source.statements)
      ? source.statements
      : []) as StatementRow[],
    transactions: (Array.isArray(source.transactions)
      ? source.transactions
      : []) as TransactionRow[],
    issues: (Array.isArray(source.issues) ? source.issues : []) as IssueRow[],
    months: [],
  };
  return withDerivedMonths(data);
}

export async function importFinanceBundle(
  current: FinanceData,
  payloadValue: unknown,
): Promise<{ data: FinanceData; imported: number }> {
  const payload = record(payloadValue, "import bundle");
  if (payload.kind === "our-finances-v2") {
    return importCanonicalLedger(current, payload);
  }
  if (payload.kind === "our-finances-legacy-v1") {
    throw new Error(
      "This workbook migration is obsolete. Convert it to canonical transactions first.",
    );
  }
  if (payload.schema_version === "1.0.0" && payload.manifest) {
    return importStatementBundle(current, payload);
  }
  throw new Error("Unsupported import bundle");
}

async function importCanonicalLedger(
  _current: FinanceData,
  payload: UnknownRecord,
): Promise<{ data: FinanceData; imported: number }> {
  if (payload.mode !== "replace") {
    throw new Error("Canonical ledger migrations must explicitly replace data");
  }
  const accounts = list(payload.accounts, "accounts").map(
    (item) =>
      ({
        ...item,
        id: required(item.id, "account.id"),
        label: required(item.label, "account.label"),
        institution: optional(item.institution),
        owner_label: optional(item.owner_label),
        account_type: optional(item.account_type),
        currency: required(item.currency, "account.currency"),
        asset_symbol: optional(item.asset_symbol),
        entry_mode:
          item.entry_mode === "manual" ? "manual" : ("statement" as const),
        active: bool(item.active),
      }) as AccountRow,
  );
  const categories = list(payload.categories, "categories").map(
    (item) =>
      ({
        ...item,
        id: required(item.id, "category.id"),
        label: required(item.label, "category.label"),
        group_name: required(item.group_name, "category.group_name"),
        sort_order: integer(item.sort_order),
        active: bool(item.active),
      }) as CategoryRow,
  );
  const balances = list(payload.balances, "balances").map(
    (item) =>
      ({
        ...item,
        id: required(item.id, "balance.id"),
        account_id: required(item.account_id, "balance.account_id"),
        as_of_date: required(item.as_of_date, "balance.as_of_date"),
        balance_text: required(item.balance_text, "balance.balance_text"),
        currency: required(item.currency, "balance.currency"),
        verification_status: required(
          item.verification_status,
          "balance.verification_status",
        ),
      }) as BalanceRow,
  );
  const prices = list(payload.prices, "prices").map(
    (item) =>
      ({
        ...item,
        id: required(item.id, "price.id"),
        symbol: required(item.symbol, "price.symbol"),
        kind: required(item.kind, "price.kind"),
        quote_currency: required(item.quote_currency, "price.quote_currency"),
        value_text: required(item.value_text, "price.value_text"),
        updated_at: optional(item.updated_at),
      }) as PriceRow,
  );
  const statements = list(payload.statements, "statements").map(
    (item) =>
      ({
        ...item,
        id: required(item.id, "statement.id"),
        source_sha256: optional(item.source_sha256),
        source_basename: required(
          item.source_basename,
          "statement.source_basename",
        ),
        source_relative_path: optional(item.source_relative_path),
        institution: optional(item.institution),
        account_id: optional(item.account_id),
        period_start: optional(item.period_start),
        period_end: optional(item.period_end),
        currency: optional(item.currency),
        opening_balance: optional(item.opening_balance),
        closing_balance: optional(item.closing_balance),
        reconciliation_status: required(
          item.reconciliation_status,
          "statement.reconciliation_status",
        ),
        validation_state: required(
          item.validation_state,
          "statement.validation_state",
        ),
        transaction_count: integer(item.transaction_count),
        unparsed_money_line_count: integer(item.unparsed_money_line_count),
        unparsed_money_lines: unparsedMoneyLines(
          item.unparsed_money_lines,
          "statement.unparsed_money_lines",
        ),
        imported_at: required(item.imported_at, "statement.imported_at"),
      }) as StatementRow,
  );
  const transactions = list(payload.transactions, "transactions").map(
    (item) =>
      ({
        ...item,
        id: required(item.id, "transaction.id"),
        statement_id: optional(item.statement_id),
        account_id: required(item.account_id, "transaction.account_id"),
        category_id: optional(item.category_id),
        transaction_date: optional(item.transaction_date),
        posted_date: optional(item.posted_date),
        description: required(item.description, "transaction.description"),
        amount_text: required(item.amount_text, "transaction.amount_text"),
        currency: required(item.currency, "transaction.currency"),
        transaction_type:
          optional(item.transaction_type) ?? "unknown",
        category_confidence: optional(item.category_confidence),
        categorization_source: optional(item.categorization_source),
        review_status: required(
          item.review_status,
          "transaction.review_status",
        ),
        source_kind:
          item.source_kind === "manual"
            ? "manual"
            : item.source_kind === "source_gap"
              ? "source_gap"
              : "statement",
        source_page: integer(item.source_page) || null,
        source_line_start: integer(item.source_line_start) || null,
        source_line_end: integer(item.source_line_end) || null,
        raw_text: optional(item.raw_text),
      }) as TransactionRow,
  );
  const issues = list(payload.issues, "issues").map(
    (item) =>
      ({
        ...item,
        id: required(item.id, "issue.id"),
        severity: required(item.severity, "issue.severity"),
        month: optional(item.month),
        account_id: optional(item.account_id),
        title: required(item.title, "issue.title"),
        detail: required(item.detail, "issue.detail"),
        status: required(item.status, "issue.status"),
        source_ref: optional(item.source_ref),
      }) as IssueRow,
  );
  const data = withDerivedMonths({
    accounts,
    categories,
    aggregates: [],
    balances,
    prices,
    statements,
    transactions,
    issues,
    months: [],
  });
  return {
    data,
    imported:
      accounts.length +
      categories.length +
      balances.length +
      prices.length +
      statements.length +
      transactions.length +
      issues.length,
  };
}

async function importStatementBundle(
  current: FinanceData,
  payload: UnknownRecord,
): Promise<{ data: FinanceData; imported: number }> {
  const manifest = record(payload.manifest, "manifest");
  const sourceTransactions = list(payload.transactions, "transactions");
  const sourceUnparsedLines = unparsedMoneyLines(
    payload.unparsed_money_lines,
    "unparsed_money_lines",
  );
  const sections = list(manifest.sections ?? [], "manifest.sections");
  const declaredCount = integer(manifest.transaction_count, -1);
  if (declaredCount !== sourceTransactions.length) {
    throw new Error("Manifest transaction count does not match bundle rows");
  }

  const statementId = required(manifest.statement_id, "manifest.statement_id");
  const sourceSha = required(manifest.source_sha256, "manifest.source_sha256");
  const now = new Date().toISOString();
  const accountSources = new Map<string, UnknownRecord>();
  for (const item of sections) {
    accountSources.set(
      required(item.account_section_id, "section.account_section_id"),
      item,
    );
  }
  for (const item of sourceTransactions) {
    const accountId = required(
      item.account_section_id,
      "transaction.account_section_id",
    );
    if (!accountSources.has(accountId)) accountSources.set(accountId, item);
  }

  const accounts = [...accountSources].map(
    ([id, item]) =>
      ({
        ...item,
        id,
        label: required(item.account_name, "account.account_name"),
        institution:
          optional(item.institution) ?? optional(manifest.detected_institution),
        owner_label: optional(item.owner_label),
        account_type: optional(item.account_type) ?? "unknown",
        currency: required(item.currency, "account.currency"),
        asset_symbol: optional(item.symbol),
        entry_mode: "statement",
        active: true,
        created_at: now,
      }) as AccountRow,
  );

  const categoriesByLabel = new Map(
    current.categories.map((item) => [item.label.toLowerCase(), item]),
  );
  const importedCategories: CategoryRow[] = [];
  for (const item of sourceTransactions) {
    const label = optional(item.category)?.trim() || "Needs review";
    const key = label.toLowerCase();
    if (!categoriesByLabel.has(key)) {
      const category: CategoryRow = {
        id: await stableId("cat", label),
        label,
        group_name: "review",
        sort_order: 900,
        active: true,
      };
      categoriesByLabel.set(key, category);
      importedCategories.push(category);
    }
  }

  const sectionStatuses = sections.map((item) => optional(item.status));
  const reconciliationStatus = sectionStatuses.includes("fail")
    ? "fail"
    : sectionStatuses.includes("market_value_review")
      ? "market_value_review"
      : sectionStatuses.length > 0 &&
          sectionStatuses.every((status) => status === "pass")
        ? "pass"
        : "insufficient_balance_data";
  const firstSection = sections[0] ?? sourceTransactions[0] ?? {};
  const statement = {
    id: statementId,
    source_sha256: sourceSha,
    source_basename: required(
      manifest.source_basename,
      "manifest.source_basename",
    ),
    source_relative_path: optional(manifest.source_relative_path),
    institution: optional(manifest.detected_institution),
    account_id: optional(firstSection.account_section_id),
    period_start: optional(firstSection.period_start),
    period_end: optional(firstSection.period_end),
    currency: optional(firstSection.currency),
    opening_balance: optional(firstSection.opening_balance),
    closing_balance: optional(firstSection.closing_balance),
    reconciliation_status: reconciliationStatus,
    validation_state: required(
      manifest.validation_state,
      "manifest.validation_state",
    ),
    transaction_count: sourceTransactions.length,
    unparsed_money_line_count: integer(manifest.unparsed_money_line_count),
    unparsed_money_lines: sourceUnparsedLines,
    imported_at: now,
    source_manifest: manifest,
  } as StatementRow;

  const balances = sections.flatMap((item) => {
    const closingBalance = optional(item.closing_balance);
    const periodEnd = optional(item.period_end);
    if (!closingBalance || !periodEnd) return [];
    const accountId = required(
      item.account_section_id,
      "section.account_section_id",
    );
    return [
      {
        id: `${statementId}:${accountId}:closing`,
        account_id: accountId,
        as_of_date: periodEnd,
        balance_text: closingBalance,
        currency: required(item.currency, "section.currency"),
        source_ref: `${statementId} closing balance`,
        balance_kind: "closing",
        source_kind: "statement",
        statement_id: statementId,
        verification_status: reconciliationStatus,
      } as BalanceRow,
    ];
  });

  const transactions = sourceTransactions.map((item) => {
    const categoryLabel = optional(item.category)?.trim() || "Needs review";
    const category = categoriesByLabel.get(categoryLabel.toLowerCase());
    if (!category) throw new Error(`Could not resolve category ${categoryLabel}`);
    return {
      ...item,
      id: required(item.transaction_id, "transaction.transaction_id"),
      statement_id: statementId,
      account_id: required(
        item.account_section_id,
        "transaction.account_section_id",
      ),
      category_id: category.id,
      transaction_date: optional(item.transaction_date),
      posted_date: optional(item.posted_date),
      description: required(item.description, "transaction.description"),
      amount_text: required(item.amount, "transaction.amount"),
      currency: required(item.currency, "transaction.currency"),
      transaction_type: optional(item.transaction_type) ?? "unknown",
      category_confidence: optional(item.category_confidence),
      categorization_source: optional(item.categorization_source),
      review_status: optional(item.review_status) ?? "needs_review",
      source_kind: "statement",
      fee_text: optional(item.fee),
      balance_text: optional(item.balance),
      quantity_text: optional(item.quantity),
      unit_price_text: optional(item.unit_price),
      symbol: optional(item.symbol),
      external_id: optional(item.external_id),
      source_page: integer(item.source_page) || null,
      source_line_start: integer(item.source_line_start) || null,
      source_line_end: integer(item.source_line_end) || null,
      raw_text: required(item.raw_text, "transaction.raw_text"),
      notes: optional(item.notes),
    } as TransactionRow;
  });

  const data = withDerivedMonths({
    ...current,
    accounts: mergeById(current.accounts, accounts),
    categories: mergeById(current.categories, importedCategories),
    statements: mergeById(current.statements, [statement]),
    transactions: mergeById(current.transactions, transactions),
    balances: mergeById(current.balances, balances),
  });
  return {
    data,
    imported:
      accounts.length +
      importedCategories.length +
      transactions.length +
      balances.length +
      1,
  };
}

function unparsedMoneyLines(value: unknown, label: string) {
  if (value === undefined || value === null) return [];
  return list(value, label).map((item, index) => ({
    page: positiveInteger(item.page, `${label}[${index}].page`),
    line: positiveInteger(item.line, `${label}[${index}].line`),
    text: required(item.text, `${label}[${index}].text`),
  }));
}

function positiveInteger(value: unknown, label: string) {
  const parsed = integer(value);
  if (parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function reviewTransaction(
  current: FinanceData,
  transactionId: string,
  categoryId: string,
): FinanceData {
  if (!current.categories.some((category) => category.id === categoryId)) {
    throw new Error("A valid category is required");
  }
  let found = false;
  const reviewedAt = new Date().toISOString();
  const transactions = current.transactions.map((transaction) => {
    if (transaction.id !== transactionId) return transaction;
    found = true;
    return {
      ...transaction,
      category_id: categoryId,
      review_status: "reviewed",
      reviewed_at: reviewedAt,
    };
  });
  if (!found) throw new Error("Transaction not found");
  return withDerivedMonths({ ...current, transactions });
}

export function withDerivedMonths(data: FinanceData): FinanceData {
  const months = [
    ...new Set([
      ...data.transactions
        .map((row) => transactionMonth(row))
        .filter((value): value is string => Boolean(value)),
      ...data.balances
        .filter((row) => row.balance_kind !== "opening")
        .map((row) => row.as_of_date.slice(0, 7))
        .filter((value) => /^\d{4}-\d{2}$/.test(value)),
    ]),
  ].sort();
  return { ...data, months };
}

export function deriveFinanceView(source: FinanceData): FinanceData {
  return deriveLedgerData(normalizeFinanceData(source)) as FinanceData;
}

export type ManualTransactionInput = {
  accountId: string;
  categoryId: string;
  transactionDate: string;
  description: string;
  amountText: string;
  notes?: string | null;
};

export function addManualTransaction(
  current: FinanceData,
  input: ManualTransactionInput,
): { data: FinanceData; transaction: TransactionRow } {
  const result = createManualRecord(current, input) as {
    data: FinanceData;
    transaction: TransactionRow;
  };
  return { ...result, data: withDerivedMonths(result.data) };
}

export function editManualTransaction(
  current: FinanceData,
  transactionId: string,
  input: ManualTransactionInput,
): { data: FinanceData; transaction: TransactionRow } {
  const result = updateManualRecord(current, transactionId, input) as {
    data: FinanceData;
    transaction: TransactionRow;
  };
  return { ...result, data: withDerivedMonths(result.data) };
}

export function removeManualTransaction(
  current: FinanceData,
  transactionId: string,
): FinanceData {
  return withDerivedMonths(
    deleteManualRecord(current, transactionId) as FinanceData,
  );
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportTransactionsCsv(data: FinanceData): string {
  const accounts = new Map(data.accounts.map((item) => [item.id, item]));
  const categories = new Map(data.categories.map((item) => [item.id, item]));
  const rows = [...data.transactions]
    .sort(
      (a, b) =>
        (a.transaction_date ?? "").localeCompare(b.transaction_date ?? "") ||
        a.id.localeCompare(b.id),
    )
    .map((transaction) => {
      const account = accounts.get(transaction.account_id);
      const category = transaction.category_id
        ? categories.get(transaction.category_id)
        : undefined;
      const row: Record<(typeof transactionColumns)[number], unknown> = {
        transaction_id: transaction.id,
        statement_id: transaction.statement_id,
        account: account?.label ?? "",
        institution: account?.institution ?? "",
        transaction_date: transaction.transaction_date,
        posted_date: transaction.posted_date,
        budget_month: transaction.budget_month,
        date_precision: transaction.date_precision,
        description: transaction.description,
        amount: transaction.amount_text,
        source_amount: transaction.source_amount_text,
        currency: transaction.currency,
        source_kind: transaction.source_kind,
        transaction_type: transaction.transaction_type,
        category: category?.label ?? "",
        category_confidence: transaction.category_confidence,
        review_status: transaction.review_status,
        fee: transaction.fee_text,
        balance: transaction.balance_text,
        quantity: transaction.quantity_text,
        unit_price: transaction.unit_price_text,
        symbol: transaction.symbol,
        external_id: transaction.external_id,
        source_page: transaction.source_page,
        source_line_start: transaction.source_line_start,
        source_line_end: transaction.source_line_end,
        raw_text: transaction.raw_text,
        notes: transaction.notes,
      };
      return transactionColumns.map((column) => csvCell(row[column])).join(",");
    });
  return [transactionColumns.join(","), ...rows].join("\r\n");
}
