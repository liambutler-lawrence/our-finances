/**
 * Return the most specific source rows available for one monthly ledger cell.
 * Canonical statement transactions take precedence over legacy workbook
 * components so the same amount is never displayed twice.
 *
 * @param {{
 *   transactions: Array<Record<string, any>>,
 *   statements: Array<Record<string, any>>
 * }} data
 * @param {{
 *   aggregate: Record<string, any> | undefined,
 *   month: string,
 *   accountId: string,
 *   categoryId: string
 * }} cell
 */
export function getCellBreakdown(data, cell) {
  const statements = new Map(
    data.statements.map((statement) => [statement.id, statement]),
  );
  const transactions = data.transactions
    .filter((transaction) => {
      const date = transaction.transaction_date ?? transaction.posted_date;
      return (
        typeof date === "string" &&
        date.startsWith(cell.month) &&
        transaction.account_id === cell.accountId &&
        transaction.category_id === cell.categoryId
      );
    })
    .sort(
      (left, right) =>
        (left.transaction_date ?? left.posted_date ?? "").localeCompare(
          right.transaction_date ?? right.posted_date ?? "",
        ) || String(left.id).localeCompare(String(right.id)),
    )
    .map((transaction) => {
      const statement = statements.get(transaction.statement_id);
      return {
        id: transaction.id,
        kind: "transaction",
        description: transaction.description,
        amountText: transaction.amount_text,
        currency: transaction.currency,
        date: transaction.transaction_date ?? transaction.posted_date ?? null,
        statementId: transaction.statement_id,
        statementName: statement?.source_basename ?? null,
        sourcePage: transaction.source_page ?? null,
        sourceLineStart: transaction.source_line_start ?? null,
        sourceLineEnd: transaction.source_line_end ?? null,
        rawText: transaction.raw_text ?? null,
        sourceRef: null,
      };
    });

  if (transactions.length) return transactions;

  const components = Array.isArray(cell.aggregate?.components)
    ? cell.aggregate.components
    : [];
  return components.map((component, index) => ({
    id: component.id,
    kind: "workbook_component",
    description: component.description ?? `Workbook amount ${index + 1}`,
    amountText: component.amount_text,
    currency:
      component.currency ?? cell.aggregate?.currency ?? "MXN",
    date: null,
    statementId: null,
    statementName: null,
    sourcePage: null,
    sourceLineStart: null,
    sourceLineEnd: null,
    rawText: null,
    sourceRef: component.source_ref ?? cell.aggregate?.source_ref ?? null,
  }));
}
