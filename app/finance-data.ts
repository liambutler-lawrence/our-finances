export type AccountRow = {
  id: string;
  label: string;
  institution: string | null;
  owner_label: string | null;
  account_type: string | null;
  currency: string;
  asset_symbol: string | null;
  active?: boolean;
  created_at?: string | null;
};

export type CategoryRow = {
  id: string;
  label: string;
  group_name: string;
  sort_order: number;
  active?: boolean;
};

export type AggregateComponentRow = {
  id: string;
  amount_text: string;
  currency: string;
  description: string | null;
  source_ref: string | null;
  statement_id?: string | null;
  statement_name?: string | null;
  statement_path?: string | null;
  source_file_sha256?: string | null;
  source_page?: number | null;
  source_line_start?: number | null;
  source_line_end?: number | null;
  raw_text?: string | null;
  transaction_date?: string | null;
  source_amount_text?: string | null;
  match_confidence?: string | null;
  match_method?: string | null;
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
  source_ref?: string | null;
  components?: AggregateComponentRow[];
  verification_status: string;
};

export type BalanceRow = {
  id: string;
  account_id: string;
  as_of_date: string;
  balance_text: string;
  currency: string;
  source_ref?: string | null;
  verification_status: string;
};

export type PriceRow = {
  id: string;
  symbol: string;
  kind: string;
  quote_currency: string;
  value_text: string;
  updated_at: string | null;
  source_ref?: string | null;
};

export type StatementRow = {
  id: string;
  source_sha256?: string | null;
  source_basename: string;
  source_relative_path?: string | null;
  institution: string | null;
  account_id?: string | null;
  period_start: string | null;
  period_end: string | null;
  currency: string | null;
  opening_balance?: string | null;
  closing_balance?: string | null;
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
  posted_date?: string | null;
  description: string;
  amount_text: string;
  currency: string;
  transaction_type: string;
  category_confidence: string | null;
  categorization_source?: string | null;
  review_status: string;
  fee_text?: string | null;
  balance_text?: string | null;
  quantity_text?: string | null;
  unit_price_text?: string | null;
  symbol?: string | null;
  external_id?: string | null;
  source_page: number | null;
  source_line_start?: number | null;
  source_line_end?: number | null;
  raw_text?: string | null;
  notes?: string | null;
  reviewed_at?: string | null;
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
  created_at?: string | null;
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
