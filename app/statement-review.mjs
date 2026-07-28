export function statementReviewTransactions(
  transactions,
  selectedStatementId = null,
  selectedMonth = null,
) {
  return (transactions ?? []).filter(
    (transaction) =>
      transaction.source_kind !== "manual" &&
      (!selectedStatementId ||
        transaction.statement_id === selectedStatementId) &&
      (!selectedMonth || transactionReviewMonth(transaction) === selectedMonth),
  );
}

export function statementReviewStatements(
  statements,
  transactions,
  selectedMonth,
) {
  if (!selectedMonth) return statements ?? [];

  const linkedStatementIds = new Set(
    statementReviewTransactions(transactions, null, selectedMonth)
      .map((transaction) => transaction.statement_id)
      .filter(Boolean),
  );

  return (statements ?? []).filter(
    (statement) =>
      linkedStatementIds.has(statement.id) ||
      statementBelongsToMonth(statement, selectedMonth),
  );
}

function transactionReviewMonth(transaction) {
  return (
    transaction.budget_month ??
    transaction.transaction_date?.slice(0, 7) ??
    transaction.posted_date?.slice(0, 7) ??
    null
  );
}

function statementBelongsToMonth(statement, month) {
  const startMonth = statement.period_start?.slice(0, 7) ?? null;
  const endMonth = statement.period_end?.slice(0, 7) ?? null;

  return endMonth ? endMonth === month : startMonth === month;
}
