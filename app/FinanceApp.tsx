"use client";

import { useMemo, useRef, useState } from "react";
import type {
  AccountRow,
  AggregateRow,
  FinanceData,
  TransactionRow,
} from "./finance-data";
import { deriveFinanceView } from "./ledger";

type Tab = "overview" | "month" | "review" | "data";

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

function money(value: number, currency = "MXN") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "MXN" ? 0 : 2,
  }).format(value);
}

function signedMoney(value: number, currency = "MXN") {
  if (value === 0) return money(0, currency);
  return `${value > 0 ? "+" : "−"}${money(Math.abs(value), currency)}`;
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
  onExport,
}: {
  data: FinanceData;
  user: { displayName: string; role: string };
  onImportBundle: (payload: unknown) => Promise<number>;
  onReviewTransaction: (
    transaction: TransactionRow,
    categoryId: string,
  ) => Promise<void>;
  onExport: () => void;
}) {
  const data = useMemo(() => deriveFinanceView(storedData), [storedData]);
  const [tab, setTab] = useState<Tab>("overview");
  const [month, setMonth] = useState(
    data.months.at(-1) ?? new Date().toISOString().slice(0, 7),
  );
  const [currency, setCurrency] = useState<"MXN" | "USD">("MXN");
  const [importStatus, setImportStatus] = useState<string>("");
  const [isImporting, setIsImporting] = useState(false);
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
  const categoryRows = monthRows
    .filter(
      (row) =>
        row.kind === "category_summary" &&
        row.category_id !== null &&
        spendingCategoryIds.has(row.category_id),
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
    (transaction) => transaction.review_status !== "reviewed",
  ).length;

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

  const isEmpty = data.aggregates.length === 0 && data.statements.length === 0;

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
                onChange={(event) => setMonth(event.target.value)}
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
                meta={`${activeAccounts.length} accounts · ${categoryRows.length} categories`}
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
                        const summary = categoryRows.find(
                          (row) => row.category_id === category.id,
                        );
                        return (
                          <tr key={category.id}>
                            <th>{category.label}</th>
                            {activeAccounts.map((account) => {
                              const row = cellRows.find(
                                (item) =>
                                  item.category_id === category.id &&
                                  item.account_id === account.id,
                              );
                              const amount = number(row?.amount_text);
                              return (
                                <td
                                  key={account.id}
                                  className={amount < 0 ? "negative-number" : ""}
                                >
                                  {amount ? signedMoney(amount, account.currency) : "·"}
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
          </section>
        ) : null}

        {!isEmpty && tab === "review" ? (
          <section className="page-stack">
            <div className="review-summary">
              <div>
                <p className="eyebrow">Review queue</p>
                <strong>{pendingCount} transactions need a decision</strong>
              </div>
              <span>
                {data.statements.filter((item) => item.validation_state === "blocked")
                  .length || 0}{" "}
                blocked statements
              </span>
            </div>
            <div className="review-layout">
              <div className="statement-list">
                {data.statements.map((statement) => (
                  <article className="statement-card" key={statement.id}>
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
                      {statement.transaction_count} rows ·{" "}
                      {statement.unparsed_money_line_count} unparsed
                    </small>
                  </article>
                ))}
              </div>
              <article className="panel transaction-panel">
                <PanelHead
                  title="Unreviewed transactions"
                  meta="Choose the final category"
                />
                <div className="transaction-list">
                  {data.transactions.map((transaction) => {
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
                            {account?.label ?? "Account"} · page{" "}
                            {transaction.source_page ?? "—"}
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
                          {data.categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                  {!data.transactions.length ? (
                    <div className="all-clear">
                      <span>✓</span>
                      <strong>Everything is reviewed</strong>
                      <p>New statement imports will appear here.</p>
                    </div>
                  ) : null}
                </div>
              </article>
            </div>
          </section>
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
                  Export a flat CSV at any time. Exact source amounts,
                  currencies, categories, and review status are included.
                </p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={onExport}
                >
                  Export transactions.csv
                </button>
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
    </main>
  );
}

function tabTitle(tab: Tab) {
  if (tab === "month") return "Monthly ledger";
  if (tab === "review") return "Statement review";
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
