import { env } from "cloudflare:workers";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    institution TEXT,
    owner_label TEXT,
    account_type TEXT,
    currency TEXT NOT NULL,
    asset_symbol TEXT,
    active INTEGER DEFAULT 1 NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    group_name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0 NOT NULL,
    active INTEGER DEFAULT 1 NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS categories_label_idx ON categories(label)`,
  `CREATE TABLE IF NOT EXISTS statements (
    id TEXT PRIMARY KEY NOT NULL,
    source_sha256 TEXT NOT NULL,
    source_basename TEXT NOT NULL,
    institution TEXT,
    account_id TEXT,
    period_start TEXT,
    period_end TEXT,
    currency TEXT,
    opening_balance TEXT,
    closing_balance TEXT,
    reconciliation_status TEXT NOT NULL,
    validation_state TEXT NOT NULL,
    transaction_count INTEGER DEFAULT 0 NOT NULL,
    unparsed_money_line_count INTEGER DEFAULT 0 NOT NULL,
    imported_at TEXT NOT NULL,
    imported_by TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS statements_sha_idx ON statements(source_sha256)`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY NOT NULL,
    statement_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    category_id TEXT,
    transaction_date TEXT,
    posted_date TEXT,
    description TEXT NOT NULL,
    amount_text TEXT NOT NULL,
    currency TEXT NOT NULL,
    transaction_type TEXT NOT NULL,
    category_confidence TEXT,
    categorization_source TEXT,
    review_status TEXT NOT NULL,
    fee_text TEXT,
    balance_text TEXT,
    quantity_text TEXT,
    unit_price_text TEXT,
    symbol TEXT,
    external_id TEXT,
    source_page INTEGER,
    source_line_start INTEGER,
    source_line_end INTEGER,
    raw_text TEXT NOT NULL,
    notes TEXT,
    reviewed_at TEXT,
    reviewed_by TEXT,
    FOREIGN KEY (statement_id) REFERENCES statements(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  )`,
  `CREATE INDEX IF NOT EXISTS transactions_review_idx ON transactions(review_status)`,
  `CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(transaction_date)`,
  `CREATE TABLE IF NOT EXISTS legacy_aggregates (
    id TEXT PRIMARY KEY NOT NULL,
    month TEXT NOT NULL,
    kind TEXT NOT NULL,
    account_id TEXT,
    category_id TEXT,
    label TEXT,
    amount_text TEXT,
    currency TEXT,
    amount_mxn_text TEXT,
    amount_usd_text TEXT,
    source_ref TEXT,
    verification_status TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  )`,
  `CREATE INDEX IF NOT EXISTS legacy_month_idx ON legacy_aggregates(month)`,
  `CREATE TABLE IF NOT EXISTS balance_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    as_of_date TEXT NOT NULL,
    balance_text TEXT NOT NULL,
    currency TEXT NOT NULL,
    source_ref TEXT,
    verification_status TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  )`,
  `CREATE TABLE IF NOT EXISTS prices (
    id TEXT PRIMARY KEY NOT NULL,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    quote_currency TEXT NOT NULL,
    value_text TEXT NOT NULL,
    updated_at TEXT,
    source_ref TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS data_issues (
    id TEXT PRIMARY KEY NOT NULL,
    severity TEXT NOT NULL,
    month TEXT,
    account_id TEXT,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL,
    source_ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  )`,
  `CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    source_name TEXT,
    imported_at TEXT NOT NULL,
    imported_by TEXT NOT NULL,
    record_count INTEGER NOT NULL
  )`,
];

let schemaReady: Promise<void> | null = null;

export function getD1(): D1Database {
  if (!env.DB) {
    throw new Error("The private data store is unavailable.");
  }
  return env.DB;
}

export async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    const db = getD1();
    schemaReady = (async () => {
      for (let index = 0; index < schemaStatements.length; index += 20) {
        const chunk = schemaStatements.slice(index, index + 20);
        await db.batch(chunk.map((statement) => db.prepare(statement)));
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function runBatch(
  statements: D1PreparedStatement[],
  chunkSize = 75,
): Promise<void> {
  const db = getD1();
  for (let index = 0; index < statements.length; index += chunkSize) {
    await db.batch(statements.slice(index, index + chunkSize));
  }
}

export async function rows<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}
