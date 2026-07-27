import { ensureSchema, getD1, rows } from "../db/runtime";

export type AccountRow = {
  id: string;
  label: string;
  institution: string | null;
  owner_label: string | null;
  account_type: string | null;
  currency: string;
  asset_symbol: string | null;
};

export type CategoryRow = {
  id: string;
  label: string;
  group_name: string;
  sort_order: number;
};

export type AggregateRow = {
  id: string;
  month: string;
  kind: string;
  account_id: string | null;
  category_id: string | null;
  label: string | null;
  amount_text: string | null;
  currency: string | null;
  amount_mxn_text: string | null;
  amount_usd_text: string | null;
  verification_status: string;
};

export type BalanceRow = {
  id: string;
  account_id: string;
  as_of_date: string;
  balance_text: string;
  currency: string;
  verification_status: string;
};

export type PriceRow = {
  id: string;
  symbol: string;
  kind: string;
  quote_currency: string;
  value_text: string;
  updated_at: string | null;
};

export type StatementRow = {
  id: string;
  source_basename: string;
  institution: string | null;
  period_start: string | null;
  period_end: string | null;
  currency: string | null;
  reconciliation_status: string;
  validation_state: string;
  transaction_count: number;
  unparsed_money_line_count: number;
  imported_at: string;
};

export type TransactionRow = {
  id: string;
  statement_id: string;
  account_id: string;
  category_id: string | null;
  transaction_date: string | null;
  description: string;
  amount_text: string;
  currency: string;
  transaction_type: string;
  category_confidence: string | null;
  review_status: string;
  source_page: number | null;
};

export type IssueRow = {
  id: string;
  severity: string;
  month: string | null;
  account_id: string | null;
  title: string;
  detail: string;
  status: string;
  source_ref: string | null;
};

export type FinanceData = {
  accounts: AccountRow[];
  categories: CategoryRow[];
  aggregates: AggregateRow[];
  balances: BalanceRow[];
  prices: PriceRow[];
  statements: StatementRow[];
  transactions: TransactionRow[];
  issues: IssueRow[];
  months: string[];
};

export const emptyFinanceData: FinanceData = {
  accounts: [],
  categories: [],
  aggregates: [],
  balances: [],
  prices: [],
  statements: [],
  transactions: [],
  issues: [],
  months: [],
};

export async function loadFinanceData(): Promise<FinanceData> {
  await ensureSchema();
  const db = getD1();
  const [
    accounts,
    categories,
    aggregates,
    balances,
    prices,
    statements,
    transactions,
    issues,
  ] = await Promise.all([
    rows<AccountRow>(
      db.prepare(
        "SELECT id, label, institution, owner_label, account_type, currency, asset_symbol FROM accounts WHERE active = 1 ORDER BY label",
      ),
    ),
    rows<CategoryRow>(
      db.prepare(
        "SELECT id, label, group_name, sort_order FROM categories WHERE active = 1 ORDER BY sort_order, label",
      ),
    ),
    rows<AggregateRow>(
      db.prepare(
        "SELECT id, month, kind, account_id, category_id, label, amount_text, currency, amount_mxn_text, amount_usd_text, verification_status FROM legacy_aggregates ORDER BY month, kind, id LIMIT 5000",
      ),
    ),
    rows<BalanceRow>(
      db.prepare(
        "SELECT id, account_id, as_of_date, balance_text, currency, verification_status FROM balance_snapshots ORDER BY as_of_date DESC LIMIT 1000",
      ),
    ),
    rows<PriceRow>(
      db.prepare(
        "SELECT id, symbol, kind, quote_currency, value_text, updated_at FROM prices ORDER BY kind, symbol LIMIT 500",
      ),
    ),
    rows<StatementRow>(
      db.prepare(
        "SELECT id, source_basename, institution, period_start, period_end, currency, reconciliation_status, validation_state, transaction_count, unparsed_money_line_count, imported_at FROM statements ORDER BY COALESCE(period_end, imported_at) DESC LIMIT 200",
      ),
    ),
    rows<TransactionRow>(
      db.prepare(
        "SELECT id, statement_id, account_id, category_id, transaction_date, description, amount_text, currency, transaction_type, category_confidence, review_status, source_page FROM transactions WHERE review_status != 'reviewed' ORDER BY COALESCE(transaction_date, '') DESC, id LIMIT 500",
      ),
    ),
    rows<IssueRow>(
      db.prepare(
        "SELECT id, severity, month, account_id, title, detail, status, source_ref FROM data_issues WHERE status = 'open' ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, month DESC LIMIT 100",
      ),
    ),
  ]);
  const months = [
    ...new Set([
      ...aggregates.map((row) => row.month),
      ...transactions
        .map((row) => row.transaction_date?.slice(0, 7))
        .filter((value): value is string => Boolean(value)),
    ]),
  ].sort();
  return {
    accounts,
    categories,
    aggregates,
    balances,
    prices,
    statements,
    transactions,
    issues,
    months,
  };
}
