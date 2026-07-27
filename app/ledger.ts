import {
  emptyFinanceData,
  type AccountRow,
  type AggregateComponentRow,
  type AggregateRow,
  type BalanceRow,
  type CategoryRow,
  type FinanceData,
  type IssueRow,
  type PriceRow,
  type StatementRow,
  type TransactionRow,
} from "./finance-data";

type UnknownRecord = Record<string, unknown>;

const transactionColumns = [
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

function aggregateComponents(
  value: unknown,
  label: string,
): AggregateComponentRow[] {
  if (value === null || value === undefined) return [];
  return list(value, label).map((item, index) => ({
    id: required(item.id, `${label}[${index}].id`),
    amount_text: required(
      item.amount_text,
      `${label}[${index}].amount_text`,
    ),
    currency: required(item.currency, `${label}[${index}].currency`),
    description: optional(item.description),
    source_ref: optional(item.source_ref),
  }));
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
  if (payload.kind === "our-finances-legacy-v1") {
    return importLegacyBundle(current, payload);
  }
  if (payload.schema_version === "1.0.0" && payload.manifest) {
    return importStatementBundle(current, payload);
  }
  throw new Error("Unsupported import bundle");
}

async function importLegacyBundle(
  current: FinanceData,
  payload: UnknownRecord,
): Promise<{ data: FinanceData; imported: number }> {
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
  const aggregates = list(payload.aggregates, "aggregates").map(
    (item) =>
      ({
        ...item,
        id: required(item.id, "aggregate.id"),
        month: required(item.month, "aggregate.month"),
        kind: required(item.kind, "aggregate.kind"),
        account_id: optional(item.account_id),
        category_id: optional(item.category_id),
        label: optional(item.label),
        amount_text: optional(item.amount_text),
        currency: optional(item.currency),
        amount_mxn_text: optional(item.amount_mxn_text),
        amount_usd_text: optional(item.amount_usd_text),
        components: aggregateComponents(
          item.components,
          `aggregate[${String(item.id ?? "unknown")}].components`,
        ),
        verification_status: required(
          item.verification_status,
          "aggregate.verification_status",
        ),
      }) as AggregateRow,
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
    ...current,
    accounts: mergeById(current.accounts, accounts),
    categories: mergeById(current.categories, categories),
    aggregates: mergeById(current.aggregates, aggregates),
    balances: mergeById(current.balances, balances),
    prices: mergeById(current.prices, prices),
    issues: mergeById(current.issues, issues),
  });
  return {
    data,
    imported:
      accounts.length +
      categories.length +
      aggregates.length +
      balances.length +
      prices.length +
      issues.length,
  };
}

async function importStatementBundle(
  current: FinanceData,
  payload: UnknownRecord,
): Promise<{ data: FinanceData; imported: number }> {
  const manifest = record(payload.manifest, "manifest");
  const sourceTransactions = list(payload.transactions, "transactions");
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
      ...data.aggregates.map((row) => row.month),
      ...data.transactions
        .map((row) => row.transaction_date?.slice(0, 7))
        .filter((value): value is string => Boolean(value)),
    ]),
  ].sort();
  return { ...data, months };
}

export function deriveFinanceView(source: FinanceData): FinanceData {
  const data = normalizeFinanceData(source);
  const storedMonths = new Set(data.aggregates.map((row) => row.month));
  const transactions = data.transactions.filter((transaction) => {
    const month = transaction.transaction_date?.slice(0, 7);
    return Boolean(month && !storedMonths.has(month));
  });
  if (!transactions.length) return data;

  const categories = new Map(data.categories.map((item) => [item.id, item]));
  const accounts = new Map(data.accounts.map((item) => [item.id, item]));
  const usdToMxn = findUsdToMxnRate(data.prices);
  const cells = new Map<string, AggregateRow>();

  for (const transaction of transactions) {
    const month = transaction.transaction_date?.slice(0, 7);
    if (!month || !transaction.category_id) continue;
    const account = accounts.get(transaction.account_id);
    const currency = transaction.currency || account?.currency || "MXN";
    const key = [month, transaction.category_id, transaction.account_id].join(":");
    const amount = Number(transaction.amount_text);
    if (!Number.isFinite(amount)) continue;
    const converted = convertAmount(amount, currency, usdToMxn);
    const current = cells.get(key);
    cells.set(key, {
      id: `derived:cell:${key}`,
      month,
      kind: "cell",
      account_id: transaction.account_id,
      category_id: transaction.category_id,
      label: categories.get(transaction.category_id)?.label ?? null,
      amount_text: String(numberOrZero(current?.amount_text) + amount),
      currency,
      amount_mxn_text: String(
        numberOrZero(current?.amount_mxn_text) + converted.mxn,
      ),
      amount_usd_text: String(
        numberOrZero(current?.amount_usd_text) + converted.usd,
      ),
      source_ref: "canonical statement transactions",
      verification_status: "derived_from_canonical_transactions",
    });
  }

  const categorySummaries = new Map<string, AggregateRow>();
  for (const cell of cells.values()) {
    if (!cell.category_id) continue;
    const key = `${cell.month}:${cell.category_id}`;
    const current = categorySummaries.get(key);
    categorySummaries.set(key, {
      id: `derived:category:${key}`,
      month: cell.month,
      kind: "category_summary",
      account_id: null,
      category_id: cell.category_id,
      label: categories.get(cell.category_id)?.label ?? cell.label,
      amount_text: null,
      currency: null,
      amount_mxn_text: String(
        numberOrZero(current?.amount_mxn_text) +
          numberOrZero(cell.amount_mxn_text),
      ),
      amount_usd_text: String(
        numberOrZero(current?.amount_usd_text) +
          numberOrZero(cell.amount_usd_text),
      ),
      source_ref: "canonical statement transactions",
      verification_status: "derived_from_canonical_transactions",
    });
  }

  const monthSummaries: AggregateRow[] = [];
  const transactionMonths = new Set(
    transactions
      .map((item) => item.transaction_date?.slice(0, 7))
      .filter((value): value is string => Boolean(value)),
  );
  for (const month of transactionMonths) {
    const rows = [...categorySummaries.values()].filter(
      (item) => item.month === month,
    );
    for (const currency of ["MXN", "USD"] as const) {
      const field =
        currency === "MXN" ? "amount_mxn_text" : "amount_usd_text";
      const income = rows
        .filter(
          (row) => categories.get(row.category_id ?? "")?.group_name === "income",
        )
        .reduce((sum, row) => sum + numberOrZero(row[field]), 0);
      const spending = rows
        .filter(
          (row) =>
            categories.get(row.category_id ?? "")?.group_name === "spending",
        )
        .reduce((sum, row) => sum + numberOrZero(row[field]), 0);
      const net = rows.reduce(
        (sum, row) => sum + numberOrZero(row[field]),
        0,
      );
      for (const [label, value] of [
        ["income", income],
        ["spending", spending],
        ["market", 0],
        ["net", net],
      ] as const) {
        const id = `derived:summary:${month}:${label}`;
        let summary = monthSummaries.find((item) => item.id === id);
        if (!summary) {
          summary = {
            id,
            month,
            kind: "month_summary",
            account_id: null,
            category_id: null,
            label,
            amount_text: null,
            currency: null,
            amount_mxn_text: null,
            amount_usd_text: null,
            source_ref: "canonical statement transactions",
            verification_status: "derived_from_canonical_transactions",
          };
          monthSummaries.push(summary);
        }
        summary[field] = String(value);
      }
    }
  }

  return withDerivedMonths({
    ...data,
    aggregates: [
      ...data.aggregates,
      ...cells.values(),
      ...categorySummaries.values(),
      ...monthSummaries,
    ],
  });
}

function numberOrZero(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findUsdToMxnRate(prices: PriceRow[]): number | null {
  const pairs = new Map<string, Partial<Record<"MXN" | "USD", number>>>();
  for (const price of prices) {
    if (price.quote_currency !== "MXN" && price.quote_currency !== "USD") {
      continue;
    }
    const value = Number(price.value_text);
    if (!Number.isFinite(value) || value === 0) continue;
    const key = `${price.symbol}:${price.kind}`;
    const pair = pairs.get(key) ?? {};
    pair[price.quote_currency] = value;
    pairs.set(key, pair);
  }
  for (const pair of pairs.values()) {
    if (pair.MXN && pair.USD) return pair.MXN / pair.USD;
  }
  return null;
}

function convertAmount(
  amount: number,
  currency: string,
  usdToMxn: number | null,
): { mxn: number; usd: number } {
  if (currency === "MXN") {
    return { mxn: amount, usd: usdToMxn ? amount / usdToMxn : 0 };
  }
  if (currency === "USD") {
    return { mxn: usdToMxn ? amount * usdToMxn : 0, usd: amount };
  }
  return { mxn: 0, usd: 0 };
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
        description: transaction.description,
        amount: transaction.amount_text,
        currency: transaction.currency,
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
