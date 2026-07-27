import { transactionMonth } from "./derive-ledger.mjs";

/**
 * Return the canonical transactions or balance inputs contributing to one
 * derived monthly ledger cell.
 */
export function getCellBreakdown(data, cell) {
  const statements = new Map(
    (data.statements ?? []).map((statement) => [statement.id, statement]),
  );
  const accountTransactions = (data.transactions ?? [])
    .filter(
      (transaction) =>
        transactionMonth(transaction) === cell.month &&
        transaction.account_id === cell.accountId,
    )
    .sort(compareTransactions);
  const formulaKind = cell.aggregate?.formula_kind;

  if (formulaKind) {
    const startingBalance = latestBalanceBefore(
      data.balances ?? [],
      cell.accountId,
      cell.month,
    );
    const actualEndingBalance = latestBalanceInMonth(
      data.balances ?? [],
      cell.accountId,
      cell.month,
    );
    const transactionItems = accountTransactions.map((transaction) =>
      transactionItem(transaction, statements),
    );

    if (formulaKind === "actual_starting_balance") {
      return startingBalance
        ? [balanceItem(startingBalance, statements)]
        : [
            formulaItem(
              `${cell.month}:${cell.accountId}:starting-zero`,
              "No earlier balance snapshot; starting at zero",
              "0",
              cell.aggregate?.currency,
            ),
          ];
    }
    if (formulaKind === "total_change") return transactionItems;
    if (formulaKind === "ending_balance") {
      return [
        ...(startingBalance
          ? [balanceItem(startingBalance, statements)]
          : [
              formulaItem(
                `${cell.month}:${cell.accountId}:starting-zero`,
                "No earlier balance snapshot; starting at zero",
                "0",
                cell.aggregate?.currency,
              ),
            ]),
        ...transactionItems,
      ];
    }
    if (formulaKind === "actual_ending_balance") {
      return actualEndingBalance
        ? [balanceItem(actualEndingBalance, statements)]
        : [];
    }
    if (formulaKind === "balance_error") {
      return [
        ...(startingBalance
          ? [balanceItem(startingBalance, statements)]
          : [
              formulaItem(
                `${cell.month}:${cell.accountId}:starting-zero`,
                "No earlier balance snapshot; starting at zero",
                "0",
                cell.aggregate?.currency,
              ),
            ]),
        ...transactionItems,
        ...(actualEndingBalance
          ? [
              balanceItem(actualEndingBalance, statements, {
                idSuffix: ":subtracted",
                amountText: String(-Number(actualEndingBalance.balance_text)),
                description: "Subtract actual ending balance",
              }),
            ]
          : []),
      ];
    }
  }

  return accountTransactions
    .filter((transaction) => transaction.category_id === cell.categoryId)
    .map((transaction) => transactionItem(transaction, statements));
}

function transactionItem(transaction, statements) {
  const statement = transaction.statement_id
    ? statements.get(transaction.statement_id)
    : null;
  const sourceKind =
    transaction.source_kind ??
    (transaction.statement_id ? "statement" : "source_gap");
  return {
    id: transaction.id,
    kind:
      sourceKind === "manual"
        ? "manual_transaction"
        : sourceKind === "source_gap"
          ? "source_gap"
          : "statement_transaction",
    sourceKind,
    description: transaction.description,
    amountText: transaction.amount_text,
    currency: transaction.currency,
    date: transaction.transaction_date ?? transaction.posted_date ?? null,
    statementId: transaction.statement_id ?? null,
    statementName: statement?.source_basename ?? null,
    statementPath: statement?.source_relative_path ?? null,
    sourcePage: transaction.source_page ?? null,
    sourceLineStart: transaction.source_line_start ?? null,
    sourceLineEnd: transaction.source_line_end ?? null,
    rawText: transaction.raw_text ?? null,
    sourceAmountText:
      transaction.source_amount_text ?? transaction.amount_text ?? null,
    matchConfidence: transaction.match_confidence ?? null,
    matchMethod: null,
    sourceRef: null,
  };
}

function balanceItem(balance, statements, overrides = {}) {
  const statement = balance.statement_id
    ? statements.get(balance.statement_id)
    : null;
  return {
    id: `${balance.id}${overrides.idSuffix ?? ""}`,
    kind: "balance_snapshot",
    sourceKind: balance.source_kind ?? "source_gap",
    description: overrides.description ?? "Balance snapshot",
    amountText: overrides.amountText ?? balance.balance_text,
    currency: balance.currency,
    date: balance.as_of_date,
    statementId: balance.statement_id ?? null,
    statementName: statement?.source_basename ?? null,
    statementPath: statement?.source_relative_path ?? null,
    sourcePage: balance.source_page ?? null,
    sourceLineStart: null,
    sourceLineEnd: null,
    rawText: balance.raw_text ?? null,
    sourceAmountText: balance.balance_text,
    matchConfidence:
      balance.source_kind === "statement"
        ? "canonical"
        : balance.source_kind === "manual_snapshot"
          ? "manual"
          : "unresolved",
    matchMethod: "balance_snapshot",
    sourceRef: balance.source_ref ?? null,
  };
}

function formulaItem(id, description, amountText, currency) {
  return {
    id,
    kind: "formula",
    sourceKind: "formula",
    description,
    amountText,
    currency: currency ?? "MXN",
    date: null,
    statementId: null,
    statementName: null,
    statementPath: null,
    sourcePage: null,
    sourceLineStart: null,
    sourceLineEnd: null,
    rawText: null,
    sourceAmountText: null,
    matchConfidence: "derived",
    matchMethod: "derived_formula",
    sourceRef: null,
  };
}

function latestBalanceBefore(balances, accountId, month) {
  const monthStart = `${month}-01`;
  return balances
    .filter(
      (item) =>
        item.account_id === accountId &&
        typeof item.as_of_date === "string" &&
        item.as_of_date < monthStart,
    )
    .sort((left, right) => right.as_of_date.localeCompare(left.as_of_date))[0];
}

function latestBalanceInMonth(balances, accountId, month) {
  const monthStart = `${month}-01`;
  const nextMonthStart = nextMonth(month);
  return balances
    .filter(
      (item) =>
        item.account_id === accountId &&
        typeof item.as_of_date === "string" &&
        item.as_of_date >= monthStart &&
        item.as_of_date < nextMonthStart,
    )
    .sort((left, right) => right.as_of_date.localeCompare(left.as_of_date))[0];
}

function nextMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
}

function compareTransactions(left, right) {
  return (
    String(left.transaction_date ?? left.posted_date ?? "").localeCompare(
      String(right.transaction_date ?? right.posted_date ?? ""),
    ) || String(left.id).localeCompare(String(right.id))
  );
}
