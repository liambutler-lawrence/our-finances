import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  email: text("email").primaryKey(),
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  createdAt: text("created_at").notNull(),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    institution: text("institution"),
    ownerLabel: text("owner_label"),
    accountType: text("account_type"),
    currency: text("currency").notNull(),
    assetSymbol: text("asset_symbol"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("accounts_active_idx").on(table.active)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    groupName: text("group_name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [uniqueIndex("categories_label_idx").on(table.label)],
);

export const statements = sqliteTable(
  "statements",
  {
    id: text("id").primaryKey(),
    sourceSha256: text("source_sha256").notNull(),
    sourceBasename: text("source_basename").notNull(),
    institution: text("institution"),
    accountId: text("account_id").references(() => accounts.id),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    currency: text("currency"),
    openingBalance: text("opening_balance"),
    closingBalance: text("closing_balance"),
    reconciliationStatus: text("reconciliation_status").notNull(),
    validationState: text("validation_state").notNull(),
    transactionCount: integer("transaction_count").notNull().default(0),
    unparsedMoneyLineCount: integer("unparsed_money_line_count")
      .notNull()
      .default(0),
    importedAt: text("imported_at").notNull(),
    importedBy: text("imported_by").notNull(),
  },
  (table) => [
    uniqueIndex("statements_sha_idx").on(table.sourceSha256),
    index("statements_period_idx").on(table.periodEnd),
  ],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    statementId: text("statement_id")
      .notNull()
      .references(() => statements.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    categoryId: text("category_id").references(() => categories.id),
    transactionDate: text("transaction_date"),
    postedDate: text("posted_date"),
    description: text("description").notNull(),
    amountText: text("amount_text").notNull(),
    currency: text("currency").notNull(),
    transactionType: text("transaction_type").notNull(),
    categoryConfidence: text("category_confidence"),
    categorizationSource: text("categorization_source"),
    reviewStatus: text("review_status").notNull(),
    feeText: text("fee_text"),
    balanceText: text("balance_text"),
    quantityText: text("quantity_text"),
    unitPriceText: text("unit_price_text"),
    symbol: text("symbol"),
    externalId: text("external_id"),
    sourcePage: integer("source_page"),
    sourceLineStart: integer("source_line_start"),
    sourceLineEnd: integer("source_line_end"),
    rawText: text("raw_text").notNull(),
    notes: text("notes"),
    reviewedAt: text("reviewed_at"),
    reviewedBy: text("reviewed_by"),
  },
  (table) => [
    index("transactions_statement_idx").on(table.statementId),
    index("transactions_date_idx").on(table.transactionDate),
    index("transactions_review_idx").on(table.reviewStatus),
  ],
);

export const legacyAggregates = sqliteTable(
  "legacy_aggregates",
  {
    id: text("id").primaryKey(),
    month: text("month").notNull(),
    kind: text("kind").notNull(),
    accountId: text("account_id").references(() => accounts.id),
    categoryId: text("category_id").references(() => categories.id),
    label: text("label"),
    amountText: text("amount_text"),
    currency: text("currency"),
    amountMxnText: text("amount_mxn_text"),
    amountUsdText: text("amount_usd_text"),
    sourceRef: text("source_ref"),
    verificationStatus: text("verification_status").notNull(),
  },
  (table) => [
    index("legacy_month_idx").on(table.month),
    index("legacy_kind_idx").on(table.kind),
  ],
);

export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    asOfDate: text("as_of_date").notNull(),
    balanceText: text("balance_text").notNull(),
    currency: text("currency").notNull(),
    sourceRef: text("source_ref"),
    verificationStatus: text("verification_status").notNull(),
  },
  (table) => [index("balances_date_idx").on(table.asOfDate)],
);

export const prices = sqliteTable(
  "prices",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull(),
    quoteCurrency: text("quote_currency").notNull(),
    valueText: text("value_text").notNull(),
    updatedAt: text("updated_at"),
    sourceRef: text("source_ref"),
  },
  (table) => [index("prices_symbol_idx").on(table.symbol)],
);

export const dataIssues = sqliteTable(
  "data_issues",
  {
    id: text("id").primaryKey(),
    severity: text("severity").notNull(),
    month: text("month"),
    accountId: text("account_id").references(() => accounts.id),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    status: text("status").notNull(),
    sourceRef: text("source_ref"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("issues_status_idx").on(table.status)],
);

export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  sourceName: text("source_name"),
  importedAt: text("imported_at").notNull(),
  importedBy: text("imported_by").notNull(),
  recordCount: integer("record_count").notNull(),
});
