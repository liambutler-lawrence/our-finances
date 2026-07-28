"use client";

import { useMemo, useRef, useState } from "react";
import type {
  AccountRow,
  AggregateRow,
  FinanceData,
  TransactionRow,
} from "./finance-data";
import { getCellBreakdown } from "./cell-breakdown.mjs";
import {
  accountEntryMode,
  FORMULA_CATEGORY_LABELS,
  transactionMonth,
} from "./derive-ledger.mjs";
import { deriveFinanceView, type ManualTransactionInput } from "./ledger";
import { money, signedMoney } from "./money.mjs";
import {
  statementReviewStatements,
  statementReviewTransactions,
} from "./statement-review.mjs";

type Tab = "overview" | "month" | "review" | "manual" | "data";
type CellBreakdownItem = ReturnType<typeof getCellBreakdown>[number];
type LedgerCellInspection = {
  key: string;
  month: string;
  categoryLabel: string;
  accountLabel: string;
  amount: number;
  currency: string;
  items: CellBreakdownItem[];
};

const monthFormatter = new Intl.DateTimeFormat("en", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function monthLabel(month: string) {
  return monthFormatter.format(new Date(`${month}-01T00:00:00Z`));
}

function number(value: string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function summaryValue(rows: AggregateRow[], label: string, currency: "MXN" | "USD") {
  const row = rows.find(
    (item) => item.kind === "month_summary" && item.label === label,
  );
  return number(currency === "MXN" ? row?.amount_mxn_text : row?.amount_usd_text);
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function FinanceApp({
  data: storedData,
  user,
  onImportBundle,
  onReviewTransaction,
  onCreateManualTransaction,
  onUpdateManualTransaction,
  onDeleteManualTransaction,
  onExportTransactions,
  onExportLedger,
}: {
  data: FinanceData;
  user: { displayName: string; role: string };
  onImportBundle: (payload: unknown) => Promise<number>;
  onReviewTransaction: (
    transaction: TransactionRow,
    categoryId: string,
  ) => Promise<void>;
  onCreateManualTransaction: (
    input: ManualTransactionInput,
  ) => Promise<TransactionRow>;
  onUpdateManualTransaction: (
    transaction: TransactionRow,
    input: ManualTransactionInput,
  ) => Promise<TransactionRow>;
  onDeleteManualTransaction: (transaction: TransactionRow) => Promise<void>;
  onExportTransactions: () => void;
  onExportLedger: () => void;
}) {
  const data = useMemo(() => deriveFinanceView(storedData), [storedData]);
  const [tab, setTab] = useState<Tab>("overview");
  const [month, setMonth] = useState(
    data.months.at(-1) ?? new Date().toISOString().slice(0, 7),
  );
  const [currency, setCurrency] = useState<"MXN" | "USD">("MXN");
  const [selectedStatementId, setSelectedStatementId] = useState<string | null>(
    null,
  );
  const [importStatus, setImportStatus] = useState<string>("");
  const [isImporting, setIsImporting] = useState(false);
  const [inspectedCell, setInspectedCell] =
    useState<LedgerCellInspection | null>(null);
  const [sourceItem, setSourceItem] = useState<CellBreakdownItem | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeMonth = data.months.includes(month)
    ? month
    : (data.months.at(-1) ?? month);

  const monthRows = useMemo(
    () => data.aggregates.filter((row) => row.month === activeMonth),
    [activeMonth, data.aggregates],
  );
  const income = summaryValue(monthRows, "income", currency);
  const spending = summaryValue(monthRows, "spending", currency);
  const market = summaryValue(monthRows, "market", currency);
  const net = summaryValue(monthRows, "net", currency);
  const currencyKey = currency === "MXN" ? "amount_mxn_text" : "amount_usd_text";
  const spendingCategoryIds = new Set(
    data.categories
      .filter((category) => category.group_name === "spending")
      .map((category) => category.id),
  );
  const categorySummaryRows = monthRows.filter(
    (row) => row.kind === "category_summary" && row.category_id !== null,
  );
  const categoryRows = categorySummaryRows
    .filter(
      (row) => row.category_id !== null && spendingCategoryIds.has(row.category_id),
    )
    .sort(
      (a, b) =>
        Math.abs(number(b[currencyKey])) - Math.abs(number(a[currencyKey])),
    );
  const cellRows = monthRows.filter((row) => row.kind === "cell");
  const activeAccountIds = new Set(cellRows.map((row) => row.account_id));
  const activeAccounts = data.accounts.filter((account) =>
    activeAccountIds.has(account.id),
  );
  const pendingCount = data.transactions.filter(
    (transaction) =>
      transaction.source_kind !== "manual" &&
      transaction.review_status !== "reviewed",
  ).length;
  const monthStatementTransactions = useMemo(
    () => statementReviewTransactions(data.transactions, null, activeMonth),
    [activeMonth, data.transactions],
  );
  const reviewStatements = useMemo(
    () =>
      statementReviewStatements(
        data.statements,
        data.transactions,
        activeMonth,
      ),
    [activeMonth, data.statements, data.transactions],
  );
  const selectedStatement =
    reviewStatements.find(
      (statement) => statement.id === selectedStatementId,
    ) ??
    null;
  const visibleStatementTransactions = useMemo(
    () =>
      statementReviewTransactions(
        data.transactions,
        selectedStatement?.id ?? null,
        activeMonth,
      ),
    [activeMonth, data.transactions, selectedStatement?.id],
  );
  const statementTransactionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const transaction of monthStatementTransactions) {
      if (!transaction.statement_id) continue;
      counts.set(
        transaction.statement_id,
        (counts.get(transaction.statement_id) ?? 0) + 1,
      );
    }
    return counts;
  }, [monthStatementTransactions]);
  const monthPendingCount = monthStatementTransactions.filter(
    (transaction) => transaction.review_status !== "reviewed",
  ).length;
  const monthSourceGapCount = monthStatementTransactions.filter(
    (transaction) => transaction.source_kind === "source_gap",
  ).length;
  const manualAccounts = data.accounts.filter(
    (account) => accountEntryMode(account) === "manual",
  );

  const trend = data.months.map((value) => {
    const rows = data.aggregates.filter((row) => row.month === value);
    return { month: value, net: summaryValue(rows, "net", currency) };
  });
  const trendMax = Math.max(1, ...trend.map((item) => Math.abs(item.net)));

  async function importBundle(file: File) {
    setIsImporting(true);
    setImportStatus("Checking the bundle…");
    try {
      const payload = JSON.parse(await file.text());
      const imported = await onImportBundle(payload);
      setImportStatus(
        `${imported} private records imported to your iCloud. Nothing was added to Git.`,
      );
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : "Import failed");
    } finally {
      setIsImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function reviewTransaction(
    transaction: TransactionRow,
    categoryId: string,
  ) {
    await onReviewTransaction(transaction, categoryId);
  }

  const isEmpty =
    data.transactions.length === 0 &&
    data.statements.length === 0 &&
    data.balances.length === 0;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            OF
          </div>
          <div>
            <strong>Our Finances</strong>
            <span>private ledger</span>
          </div>
        </div>

        <nav className="main-nav" aria-label="Main navigation">
          <NavButton
            active={tab === "overview"}
            label="Overview"
            glyph="⌁"
            onClick={() => setTab("overview")}
          />
          <NavButton
            active={tab === "month"}
            label="Monthly ledger"
            glyph="▦"
            onClick={() => setTab("month")}
          />
          <NavButton
            active={tab === "review"}
            label="Review statements"
            glyph="✓"
            badge={pendingCount || undefined}
            onClick={() => setTab("review")}
          />
          <NavButton
            active={tab === "manual"}
            label="Manual accounts"
            glyph="＋"
            onClick={() => setTab("manual")}
          />
          <NavButton
            active={tab === "data"}
            label="Data & prices"
            glyph="↕"
            onClick={() => setTab("data")}
          />
        </nav>

        <div className="sidebar-foot">
          <div className="privacy-chip">
            <span aria-hidden="true">●</span>
            Your private iCloud
          </div>
          <div className="user-row">
            <span className="avatar">{initials(user.displayName)}</span>
            <div>
              <strong>{user.displayName}</strong>
              <span>{user.role}</span>
            </div>
            <div id="apple-sign-out-button" className="apple-signout-slot" />
          </div>
        </div>
      </aside>

      <section className="workspace">
        <input
          ref={fileInput}
          hidden
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importBundle(file);
          }}
        />
        <header className="topbar">
          <div>
            <p className="eyebrow">Household budget</p>
            <h1>{tabTitle(tab)}</h1>
          </div>
          <div className="topbar-actions">
            <label className="month-control">
              <span className="sr-only">Month</span>
              <select
                value={activeMonth}
                onChange={(event) => {
                  setMonth(event.target.value);
                  setSelectedStatementId(null);
                  setInspectedCell(null);
                  setSourceItem(null);
                }}
              >
                {data.months.length ? (
                  [...data.months].reverse().map((value) => (
                    <option key={value} value={value}>
                      {monthLabel(value)}
                    </option>
                  ))
                ) : (
                  <option value={activeMonth}>{monthLabel(activeMonth)}</option>
                )}
              </select>
            </label>
            <div className="currency-toggle" aria-label="Display currency">
              {(["MXN", "USD"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={currency === value ? "active" : ""}
                  onClick={() => setCurrency(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </header>

        {isEmpty ? (
          <EmptyState
            onImport={() => fileInput.current?.click()}
            isImporting={isImporting}
            status={importStatus}
          />
        ) : null}

        {!isEmpty && tab === "overview" ? (
          <section className="page-stack">
            {data.issues.length ? <IssueBanner count={data.issues.length} /> : null}
            <div className="metric-grid">
              <Metric
                label="Income"
                value={money(income, currency)}
                tone="positive"
                helper="Salary, gifts, interest"
              />
              <Metric
                label="Spending"
                value={money(Math.abs(spending), currency)}
                tone="negative"
                helper="Everyday categories"
              />
              <Metric
                label="Net change"
                value={signedMoney(net, currency)}
                tone={net >= 0 ? "positive" : "negative"}
                helper="Income + spending + market"
              />
              <Metric
                label="Market exposure"
                value={signedMoney(market, currency)}
                tone="neutral"
                helper="Investments and FX movement"
              />
            </div>

            <div className="dashboard-grid">
              <article className="panel trend-panel">
                <PanelHead
                  title="Monthly net change"
                  meta={`${trend.length} months · ${currency}`}
                />
                <div className="trend-chart" aria-label="Monthly net change chart">
                  {trend.map((item) => {
                    const height = Math.max(6, (Math.abs(item.net) / trendMax) * 88);
                    return (
                      <div className="trend-column" key={item.month}>
                        <span className="trend-value">
                          {Math.round(item.net / 1000)}k
                        </span>
                        <div className="trend-track">
                          <span
                            className={item.net >= 0 ? "bar positive" : "bar negative"}
                            style={{ height: `${height}%` }}
                          />
                        </div>
                        <span>{item.month.slice(5)}</span>
                      </div>
                    );
                  })}
                </div>
              </article>

              <article className="panel">
                <PanelHead
                  title="Where it went"
                  meta={monthLabel(activeMonth)}
                />
                <div className="category-list">
                  {categoryRows.slice(0, 8).map((row, index) => {
                    const value = Math.abs(number(row[currencyKey]));
                    const maximum = Math.max(
                      1,
                      ...categoryRows.map((item) =>
                        Math.abs(number(item[currencyKey])),
                      ),
                    );
                    return (
                      <div className="category-row" key={row.id}>
                        <span className={`category-dot tone-${index % 5}`} />
                        <span className="category-name">{row.label}</span>
                        <span className="category-bar">
                          <span style={{ width: `${(value / maximum) * 100}%` }} />
                        </span>
                        <strong>{money(value, currency)}</strong>
                      </div>
                    );
                  })}
                  {!categoryRows.length ? (
                    <p className="muted-copy">No categorized spending this month.</p>
                  ) : null}
                </div>
              </article>
            </div>

            <article className="panel">
              <PanelHead
                title="Account balances"
                meta={`${activeAccounts.length} active in ${monthLabel(activeMonth)}`}
              />
              <AccountStrip
                accounts={activeAccounts}
                balances={data.balances.filter((row) =>
                  row.as_of_date.startsWith(activeMonth),
                )}
              />
            </article>
          </section>
        ) : null}

        {!isEmpty && tab === "month" ? (
          <section className="page-stack">
            <div className="ledger-note">
              <span>Pure view</span>
              Values are derived from imported statements and balance snapshots.
              Edit categories in the review queue.
            </div>
            <article className="panel ledger-panel">
              <PanelHead
                title={monthLabel(activeMonth)}
                meta={`${activeAccounts.length} accounts · ${cellRows.length} derived cells`}
              />
              <div className="ledger-scroll">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      {activeAccounts.map((account) => (
                        <th key={account.id}>
                          <span>{account.label}</span>
                          <small>{account.currency}</small>
                        </th>
                      ))}
                      <th>Total {currency}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.categories
                      .filter((category) =>
                        cellRows.some((row) => row.category_id === category.id),
                      )
                      .map((category) => {
                        const summary = categorySummaryRows.find(
                          (row) => row.category_id === category.id,
                        );
                        const isFormula = FORMULA_CATEGORY_LABELS.has(
                          category.label,
                        );
                        return (
                          <tr
                            key={category.id}
                            className={isFormula ? "formula-row" : ""}
                          >
                            <th>
                              {category.label}
                              {isFormula ? <small>Derived</small> : null}
                            </th>
                            {activeAccounts.map((account) => {
                              const row = cellRows.find(
                                (item) =>
                                  item.category_id === category.id &&
                                  item.account_id === account.id,
                              );
                              const amount = number(row?.amount_text);
                              const hasValue = row?.amount_text != null;
                              const cellKey = [
                                activeMonth,
                                category.id,
                                account.id,
                              ].join(":");
                              const inspectCell = () => {
                                if (!hasValue) return;
                                setInspectedCell({
                                  key: cellKey,
                                  month: activeMonth,
                                  categoryLabel: category.label,
                                  accountLabel: account.label,
                                  amount,
                                  currency: account.currency,
                                  items: getCellBreakdown(data, {
                                    aggregate: row,
                                    month: activeMonth,
                                    accountId: account.id,
                                    categoryId: category.id,
                                  }),
                                });
                              };
                              return (
                                <td
                                  key={account.id}
                                  className={`ledger-cell ${
                                    amount < 0 ? "negative-number" : ""
                                  }`}
                                >
                                  {hasValue ? (
                                    <button
                                      type="button"
                                      className="ledger-cell-trigger"
                                      aria-expanded={inspectedCell?.key === cellKey}
                                      aria-label={`Show the amounts contributing to ${category.label} in ${account.label}`}
                                      onMouseEnter={inspectCell}
                                      onFocus={inspectCell}
                                      onClick={inspectCell}
                                    >
                                      {signedMoney(amount, account.currency)}
                                    </button>
                                  ) : (
                                    "·"
                                  )}
                                </td>
                              );
                            })}
                            <td className="row-total">
                              {signedMoney(number(summary?.[currencyKey]), currency)}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </article>
            {inspectedCell?.month === activeMonth ? (
              <LedgerCellInspector
                inspection={inspectedCell}
                onClose={() => setInspectedCell(null)}
                onOpenSource={setSourceItem}
              />
            ) : null}
          </section>
        ) : null}

        {!isEmpty && tab === "review" ? (
          <section className="page-stack">
            <div className="review-summary">
              <div>
                <p className="eyebrow">Review queue</p>
                <strong>
                  {monthPendingCount} transactions need a decision in{" "}
                  {monthLabel(activeMonth)}
                </strong>
              </div>
              <span>
                {monthSourceGapCount} source gap
                {monthSourceGapCount === 1 ? "" : "s"} ·{" "}
                {reviewStatements.filter(
                  (item) => item.validation_state === "blocked",
                ).length || 0} blocked statements
              </span>
            </div>
            <div className="review-layout">
              <div
                className="statement-list"
                role="group"
                aria-label="Filter by statement"
              >
                <button
                  type="button"
                  className="statement-card statement-card-all"
                  aria-pressed={!selectedStatement}
                  onClick={() => setSelectedStatementId(null)}
                >
                  <div>
                    <span className="institution-mark">ALL</span>
                    <div>
                      <strong>All statements</strong>
                      <span>
                        {reviewStatements.length} statements in{" "}
                        {monthLabel(activeMonth)}
                      </span>
                    </div>
                  </div>
                  <span className="statement-filter-count">
                    {monthStatementTransactions.length}
                  </span>
                  <small>
                    Includes this month&apos;s transactions awaiting statement
                    matching
                  </small>
                </button>
                {reviewStatements.map((statement) => (
                  <button
                    type="button"
                    className="statement-card"
                    key={statement.id}
                    aria-label={`Filter transactions to ${statement.source_basename}`}
                    aria-pressed={selectedStatement?.id === statement.id}
                    onClick={() => setSelectedStatementId(statement.id)}
                  >
                    <div>
                      <span className="institution-mark">
                        {initials(statement.institution ?? "Statement")}
                      </span>
                      <div>
                        <strong>{statement.institution ?? "Statement"}</strong>
                        <span>
                          {statement.period_end
                            ? monthLabel(statement.period_end.slice(0, 7))
                            : "Unknown period"}
                        </span>
                      </div>
                    </div>
                    <StatusPill status={statement.validation_state} />
                    <small>
                      <span title={statement.source_basename}>
                        {statement.source_basename}
                      </span>
                      {statementTransactionCounts.get(statement.id) ?? 0} linked ·{" "}
                      {statement.transaction_count} source rows ·{" "}
                      {statement.unparsed_money_line_count} unparsed
                    </small>
                  </button>
                ))}
              </div>
              <article className="panel transaction-panel">
                <PanelHead
                  title={
                    selectedStatement
                      ? selectedStatement.source_basename
                      : "Found transactions"
                  }
                  meta={`${visibleStatementTransactions.length} shown · amounts are read-only`}
                />
                <div className="transaction-list">
                  {visibleStatementTransactions.map((transaction) => {
                    const account = data.accounts.find(
                      (item) => item.id === transaction.account_id,
                    );
                    return (
                      <div className="transaction-row" key={transaction.id}>
                        <div className="transaction-date">
                          <strong>
                            {transaction.transaction_date?.slice(8, 10) ?? "—"}
                          </strong>
                          <span>
                            {transaction.transaction_date
                              ? monthLabel(transaction.transaction_date.slice(0, 7))
                                  .split(" ")[0]
                                  .slice(0, 3)
                              : ""}
                          </span>
                        </div>
                        <div className="transaction-copy">
                          <strong>{transaction.description}</strong>
                          <span>
                            {account?.label ?? "Account"} ·{" "}
                            {transaction.source_kind === "source_gap"
                              ? "source statement still unmatched"
                              : `page ${transaction.source_page ?? "—"}`}
                          </span>
                          {transaction.source_kind === "source_gap" ? (
                            <small className="source-gap-label">
                              Needs statement matching
                            </small>
                          ) : transaction.match_confidence === "medium" ? (
                            <small className="source-confidence">
                              Statement match needs verification
                            </small>
                          ) : null}
                        </div>
                        <strong
                          className={
                            number(transaction.amount_text) < 0
                              ? "negative-number"
                              : "positive-number"
                          }
                        >
                          {signedMoney(
                            number(transaction.amount_text),
                            transaction.currency,
                          )}
                        </strong>
                        <select
                          aria-label={`Category for ${transaction.description}`}
                          defaultValue={transaction.category_id ?? ""}
                          onChange={(event) =>
                            reviewTransaction(transaction, event.target.value)
                          }
                        >
                          <option value="" disabled>
                            Choose category
                          </option>
                          {data.categories
                            .filter(
                              (category) =>
                                !FORMULA_CATEGORY_LABELS.has(category.label),
                            )
                            .map((category) => (
                              <option key={category.id} value={category.id}>
                                {category.label}
                              </option>
                            ))}
                        </select>
                      </div>
                    );
                  })}
                  {!visibleStatementTransactions.length ? (
                    <div className="all-clear">
                      <span>✓</span>
                      <strong>
                        {selectedStatement
                          ? "No linked transactions"
                          : "Everything is reviewed"}
                      </strong>
                      <p>
                        {selectedStatement
                          ? "This statement has no transactions linked to it."
                          : "New statement imports will appear here."}
                      </p>
                    </div>
                  ) : null}
                </div>
              </article>
            </div>
          </section>
        ) : null}

        {!isEmpty && tab === "manual" ? (
          <ManualAccountsPanel
            key={activeMonth}
            data={data}
            accounts={manualAccounts}
            activeMonth={activeMonth}
            onCreate={onCreateManualTransaction}
            onUpdate={onUpdateManualTransaction}
            onDelete={onDeleteManualTransaction}
          />
        ) : null}

        {!isEmpty && tab === "data" ? (
          <section className="page-stack">
            <div className="data-grid">
              <article className="panel import-panel">
                <p className="eyebrow">Private import</p>
                <h2>Bring in a statement bundle</h2>
                <p>
                  Use the project skill to extract and reconcile a PDF, then
                  upload the generated bundle here. Files and values stay out of
                  the public repository.
                </p>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={isImporting}
                >
                  {isImporting ? "Importing…" : "Choose private bundle"}
                </button>
                {importStatus ? <p className="import-status">{importStatus}</p> : null}
              </article>
              <article className="panel export-panel">
                <p className="eyebrow">Portable by design</p>
                <h2>Take every transaction with you</h2>
                <p>
                  Export the complete private ledger as JSON, or a flat
                  transaction CSV with exact source amounts, categories, and
                  review status.
                </p>
                <div className="export-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={onExportLedger}
                  >
                    Export full ledger.json
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={onExportTransactions}
                  >
                    Export transactions.csv
                  </button>
                </div>
              </article>
            </div>

            <article className="panel">
              <PanelHead
                title="Price lookups"
                meta={`${data.prices.length} stored snapshots`}
              />
              <div className="price-table-wrap">
                <table className="price-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Type</th>
                      <th>Price</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.prices.map((price) => (
                      <tr key={price.id}>
                        <th>{price.symbol}</th>
                        <td>{price.kind}</td>
                        <td>
                          {price.kind.endsWith("_count")
                            ? `${price.value_text} ${price.quote_currency}`
                            : money(
                                number(price.value_text),
                                price.quote_currency,
                              )}
                        </td>
                        <td>{price.updated_at?.slice(0, 10) ?? "Source snapshot"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            {data.issues.length ? (
              <article className="panel">
                <PanelHead
                  title="Data quality issues"
                  meta={`${data.issues.length} open`}
                />
                <div className="issue-list">
                  {data.issues.map((issue) => (
                    <div className="issue-row" key={issue.id}>
                      <span className={`issue-icon ${issue.severity}`}>!</span>
                      <div>
                        <strong>{issue.title}</strong>
                        <p>{issue.detail}</p>
                        <small>
                          {issue.month ? monthLabel(issue.month) : "Workbook"} ·{" "}
                          {issue.source_ref}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            ) : null}
          </section>
        ) : null}
      </section>
      {sourceItem ? (
        <StatementSourceDialog
          item={sourceItem}
          onClose={() => setSourceItem(null)}
        />
      ) : null}
    </main>
  );
}

function tabTitle(tab: Tab) {
  if (tab === "month") return "Monthly ledger";
  if (tab === "review") return "Statement review";
  if (tab === "manual") return "Manual accounts";
  if (tab === "data") return "Data & price lookups";
  return "Overview";
}

function NavButton({
  active,
  label,
  glyph,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  glyph: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button type="button" className={active ? "active" : ""} onClick={onClick}>
      <span aria-hidden="true">{glyph}</span>
      {label}
      {badge ? <small>{badge}</small> : null}
    </button>
  );
}

function Metric({
  label,
  value,
  helper,
  tone,
}: {
  label: string;
  value: string;
  helper: string;
  tone: "positive" | "negative" | "neutral";
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
    </article>
  );
}

function PanelHead({ title, meta }: { title: string; meta: string }) {
  return (
    <header className="panel-head">
      <h2>{title}</h2>
      <span>{meta}</span>
    </header>
  );
}

function AccountStrip({
  accounts,
  balances,
}: {
  accounts: AccountRow[];
  balances: FinanceData["balances"];
}) {
  return (
    <div className="account-strip">
      {accounts.slice(0, 8).map((account) => {
        const balance = balances.find((row) => row.account_id === account.id);
        return (
          <div className="account-card" key={account.id}>
            <span className="institution-mark">
              {initials(account.institution ?? account.label)}
            </span>
            <div>
              <strong>{account.label}</strong>
              <span>{account.owner_label ?? account.account_type}</span>
            </div>
            <strong>{money(number(balance?.balance_text), account.currency)}</strong>
          </div>
        );
      })}
      {!accounts.length ? (
        <p className="muted-copy">No balance snapshots for this month.</p>
      ) : null}
    </div>
  );
}

function ManualAccountsPanel({
  data,
  accounts,
  activeMonth,
  onCreate,
  onUpdate,
  onDelete,
}: {
  data: FinanceData;
  accounts: AccountRow[];
  activeMonth: string;
  onCreate: (input: ManualTransactionInput) => Promise<TransactionRow>;
  onUpdate: (
    transaction: TransactionRow,
    input: ManualTransactionInput,
  ) => Promise<TransactionRow>;
  onDelete: (transaction: TransactionRow) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [editing, setEditing] = useState<TransactionRow | null>(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    transactionDate: `${activeMonth}-01`,
    description: "",
    amountText: "",
    categoryId:
      data.categories.find(
        (category) =>
          category.active !== false &&
          !FORMULA_CATEGORY_LABELS.has(category.label),
      )?.id ?? "",
  });
  const selectedAccount =
    accounts.find((account) => account.id === accountId) ?? accounts[0];
  const transactionCategories = data.categories.filter(
    (category) =>
      category.active !== false &&
      !FORMULA_CATEGORY_LABELS.has(category.label),
  );
  const transactions = data.transactions
    .filter(
      (transaction) =>
        transaction.source_kind === "manual" &&
        transaction.account_id === selectedAccount?.id &&
        transactionMonth(transaction) === activeMonth,
    )
    .sort(
      (left, right) =>
        String(right.transaction_date ?? "").localeCompare(
          String(left.transaction_date ?? ""),
        ) || right.id.localeCompare(left.id),
    );
  const accountCells = data.aggregates.filter(
    (row) =>
      row.kind === "cell" &&
      row.month === activeMonth &&
      row.account_id === selectedAccount?.id,
  );
  const formulaValue = (label: string) =>
    number(accountCells.find((row) => row.label === label)?.amount_text);

  function resetDraft() {
    setEditing(null);
    setDraft({
      transactionDate: `${activeMonth}-01`,
      description: "",
      amountText: "",
      categoryId: transactionCategories[0]?.id ?? "",
    });
  }

  function beginEditing(transaction: TransactionRow) {
    setEditing(transaction);
    setStatus("");
    setDraft({
      transactionDate:
        transaction.transaction_date ?? `${activeMonth}-01`,
      description: transaction.description,
      amountText: transaction.amount_text,
      categoryId: transaction.category_id ?? transactionCategories[0]?.id ?? "",
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAccount) return;
    setSaving(true);
    setStatus("");
    const input: ManualTransactionInput = {
      accountId: selectedAccount.id,
      categoryId: draft.categoryId,
      transactionDate: draft.transactionDate,
      description: draft.description,
      amountText: draft.amountText,
    };
    try {
      if (editing) {
        await onUpdate(editing, input);
        setStatus("Transaction updated in your private iCloud ledger.");
      } else {
        await onCreate(input);
        setStatus("Transaction added to your private iCloud ledger.");
      }
      resetDraft();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function remove(transaction: TransactionRow) {
    if (!window.confirm(`Delete “${transaction.description}”?`)) return;
    setSaving(true);
    setStatus("");
    try {
      await onDelete(transaction);
      if (editing?.id === transaction.id) resetDraft();
      setStatus("Transaction deleted from your private iCloud ledger.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete");
    } finally {
      setSaving(false);
    }
  }

  if (!selectedAccount) {
    return (
      <section className="page-stack">
        <article className="panel all-clear">
          <strong>No manually managed accounts yet</strong>
          <p>Cash, in-transit, and work-debt accounts appear here.</p>
        </article>
      </section>
    );
  }

  return (
    <section className="page-stack">
      <div className="ledger-note">
        <span>Manual ledger</span>
        Cash, in-transit, and work-debt transactions can be added and edited
        directly. Their monthly totals remain derived.
      </div>
      <article className="panel manual-account-head">
        <label>
          <span>Account</span>
          <select
            value={selectedAccount.id}
            onChange={(event) => {
              setAccountId(event.target.value);
              resetDraft();
              setStatus("");
            }}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        </label>
        <div className="manual-balance-metrics">
          <Metric
            label="Starting balance"
            value={money(
              formulaValue("ACTUAL STARTING BALANCE"),
              selectedAccount.currency,
            )}
            helper="Prior balance snapshot"
            tone="neutral"
          />
          <Metric
            label="Total change"
            value={signedMoney(
              formulaValue("TOTAL CHANGE"),
              selectedAccount.currency,
            )}
            helper={`${transactions.length} manual transactions`}
            tone={
              formulaValue("TOTAL CHANGE") >= 0 ? "positive" : "negative"
            }
          />
          <Metric
            label="Ending balance"
            value={money(
              formulaValue("ENDING BALANCE"),
              selectedAccount.currency,
            )}
            helper="Starting balance + change"
            tone="neutral"
          />
        </div>
      </article>

      <div className="manual-account-layout">
        <article className="panel manual-entry-panel">
          <p className="eyebrow">
            {editing ? "Edit manual transaction" : "Add manual transaction"}
          </p>
          <h2>{selectedAccount.label}</h2>
          <form className="manual-entry-form" onSubmit={submit}>
            <label>
              <span>Date</span>
              <input
                type="date"
                required
                value={draft.transactionDate}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    transactionDate: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Description</span>
              <input
                required
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="What happened?"
              />
            </label>
            <label>
              <span>Signed amount ({selectedAccount.currency})</span>
              <input
                required
                inputMode="decimal"
                value={draft.amountText}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    amountText: event.target.value,
                  }))
                }
                placeholder="-250 or 1000"
              />
            </label>
            <label>
              <span>Category</span>
              <select
                required
                value={draft.categoryId}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    categoryId: event.target.value,
                  }))
                }
              >
                {transactionCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="manual-entry-actions">
              <button className="primary-button" type="submit" disabled={saving}>
                {saving
                  ? "Saving…"
                  : editing
                    ? "Save changes"
                    : "Add transaction"}
              </button>
              {editing ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={resetDraft}
                  disabled={saving}
                >
                  Cancel
                </button>
              ) : null}
            </div>
            {status ? <p className="import-status">{status}</p> : null}
          </form>
        </article>

        <article className="panel manual-transaction-panel">
          <PanelHead
            title={monthLabel(activeMonth)}
            meta={`${transactions.length} editable transactions`}
          />
          <div className="manual-transaction-list">
            {transactions.map((transaction) => (
              <div className="manual-transaction-row" key={transaction.id}>
                <div>
                  <strong>{transaction.description}</strong>
                  <span>
                    {transaction.transaction_date ?? "Month only"} ·{" "}
                    {data.categories.find(
                      (category) => category.id === transaction.category_id,
                    )?.label ?? "Needs category"}
                  </span>
                </div>
                <strong
                  className={
                    number(transaction.amount_text) < 0
                      ? "negative-number"
                      : "positive-number"
                  }
                >
                  {signedMoney(
                    number(transaction.amount_text),
                    transaction.currency,
                  )}
                </strong>
                <div className="manual-row-actions">
                  <button type="button" onClick={() => beginEditing(transaction)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void remove(transaction)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {!transactions.length ? (
              <div className="all-clear">
                <span>＋</span>
                <strong>No transactions this month</strong>
                <p>Add the first entry with the form.</p>
              </div>
            ) : null}
          </div>
        </article>
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const label =
    status === "ready_for_review"
      ? "Ready"
      : status === "ready_for_import"
        ? "Reviewed"
        : "Blocked";
  return <span className={`status-pill ${status}`}>{label}</span>;
}

function IssueBanner({ count }: { count: number }) {
  return (
    <div className="issue-banner">
      <span aria-hidden="true">!</span>
      <div>
        <strong>{count} source-data issue{count === 1 ? "" : "s"} need attention</strong>
        <p>They are preserved as audit findings instead of being silently copied.</p>
      </div>
    </div>
  );
}

function LedgerCellInspector({
  inspection,
  onClose,
  onOpenSource,
}: {
  inspection: LedgerCellInspection;
  onClose: () => void;
  onOpenSource: (item: CellBreakdownItem) => void;
}) {
  const itemTotal = inspection.items.reduce(
    (sum, item) => sum + number(item.amountText),
    0,
  );
  const reconciles =
    inspection.items.length > 0 &&
    Math.abs(itemTotal - inspection.amount) < 0.00000001;

  return (
    <aside
      className="cell-inspector"
      data-testid="cell-breakdown-panel"
      aria-label="Ledger cell breakdown"
    >
      <header>
        <div>
          <p className="eyebrow">{inspection.accountLabel}</p>
          <h2>{inspection.categoryLabel}</h2>
        </div>
        <button
          type="button"
          className="inspector-close"
          aria-label="Close cell breakdown"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {inspection.items.length ? (
        <>
          <ol className="cell-component-list">
            {inspection.items.map((item) => {
              const hasStatementSource = Boolean(
                item.statementId || item.sourcePage || item.rawText,
              );
              return (
                <li key={item.id}>
                  <div>
                    <strong>{item.description}</strong>
                    <span>
                      {[item.date, item.statementName]
                        .filter(Boolean)
                        .join(" · ") ||
                        (item.sourceKind === "manual"
                          ? "Manual transaction"
                          : item.sourceKind === "source_gap"
                            ? "Source gap"
                            : item.sourceKind === "formula"
                              ? "Derived formula"
                              : "Balance snapshot")}
                    </span>
                    {item.matchConfidence === "medium" ? (
                      <small className="source-confidence">
                        Statement match needs verification
                      </small>
                    ) : item.sourceKind === "source_gap" ? (
                      <small className="source-gap-label">
                        Needs statement matching
                      </small>
                    ) : null}
                  </div>
                  <strong
                    className={
                      number(item.amountText) < 0
                        ? "negative-number"
                        : "positive-number"
                    }
                  >
                    {signedMoney(number(item.amountText), item.currency)}
                  </strong>
                  {hasStatementSource ? (
                    <button
                      type="button"
                      className="source-link"
                      onClick={() => onOpenSource(item)}
                    >
                      View statement source
                      {item.sourcePage ? ` · p. ${item.sourcePage}` : ""}
                    </button>
                  ) : item.sourceRef ? (
                    <small>{item.sourceRef}</small>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <footer>
            <span>
              {inspection.items.length} amount
              {inspection.items.length === 1 ? "" : "s"}
            </span>
            <strong>{signedMoney(inspection.amount, inspection.currency)}</strong>
          </footer>
          {!reconciles ? (
            <p className="component-warning">
              The stored breakdown does not equal this ledger cell. The ledger
              total has not been altered.
            </p>
          ) : null}
        </>
      ) : (
        <p className="inspector-empty">
          No transactions or balance inputs contribute to this value.
        </p>
      )}
    </aside>
  );
}

function StatementSourceDialog({
  item,
  onClose,
}: {
  item: CellBreakdownItem;
  onClose: () => void;
}) {
  const lineLabel =
    item.sourceLineStart && item.sourceLineEnd
      ? item.sourceLineStart === item.sourceLineEnd
        ? `line ${item.sourceLineStart}`
        : `lines ${item.sourceLineStart}–${item.sourceLineEnd}`
      : null;

  return (
    <div className="source-dialog-backdrop">
      <section
        className="source-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-dialog-title"
      >
        <header>
          <div>
            <p className="eyebrow">Preserved statement evidence</p>
            <h2 id="source-dialog-title">{item.description}</h2>
          </div>
          <button
            type="button"
            className="inspector-close"
            aria-label="Close statement source"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <dl>
          <div>
            <dt>Statement</dt>
            <dd>{item.statementName ?? item.statementId ?? "Imported statement"}</dd>
          </div>
          {item.statementPath ? (
            <div>
              <dt>iCloud Drive source</dt>
              <dd>LiamarFinances/Statements/{item.statementPath}</dd>
            </div>
          ) : null}
          <div>
            <dt>Locator</dt>
            <dd>
              {[
                item.sourcePage ? `page ${item.sourcePage}` : null,
                lineLabel,
              ]
                .filter(Boolean)
                .join(" · ") || "Source locator unavailable"}
            </dd>
          </div>
          <div>
            <dt>Exact amount</dt>
            <dd>{signedMoney(number(item.amountText), item.currency)}</dd>
          </div>
          {item.matchConfidence ? (
            <div>
              <dt>Source match</dt>
              <dd>
                {item.matchConfidence === "medium"
                  ? "Needs verification"
                  : item.matchConfidence === "canonical"
                    ? "Canonical statement row"
                    : "High-confidence amount match"}
              </dd>
            </div>
          ) : null}
        </dl>
        {item.rawText ? (
          <pre>{item.rawText}</pre>
        ) : (
          <p className="inspector-empty">
            The source page is identified, but its original text was not stored.
          </p>
        )}
        <p className="source-dialog-note">
          This is the preserved page-and-line locator from your private import.
          The original PDF remains in your own file storage.
        </p>
      </section>
    </div>
  );
}

function EmptyState({
  onImport,
  isImporting,
  status,
}: {
  onImport: () => void;
  isImporting: boolean;
  status: string;
}) {
  return (
    <section className="empty-state">
      <div className="empty-orbit" aria-hidden="true">
        <span>↗</span>
      </div>
      <p className="eyebrow">Protected and empty</p>
      <h2>Your source code is live. Your financial data is not in it.</h2>
      <p>
        Import the private migration bundle to populate the monthly ledger,
        totals, balances, and price snapshots.
      </p>
      <button
        className="primary-button"
        type="button"
        onClick={onImport}
        disabled={isImporting}
      >
        {isImporting ? "Importing…" : "Import private data"}
      </button>
      {status ? <p className="import-status">{status}</p> : null}
    </section>
  );
}
