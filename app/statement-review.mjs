export function statementReviewTransactions(
  transactions,
  selectedStatementId = null,
) {
  return (transactions ?? []).filter(
    (transaction) =>
      transaction.source_kind !== "manual" &&
      (!selectedStatementId ||
        transaction.statement_id === selectedStatementId),
  );
}
