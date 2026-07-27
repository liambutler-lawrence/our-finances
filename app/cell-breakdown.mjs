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
  const components = Array.isArray(cell.aggregate?.components)
    ? cell.aggregate.components
    : [];
  const hasLinkedComponents = components.some(
    (component) =>
      component.statement_id ||
      component.source_page ||
      component.raw_text,
  );
  if (hasLinkedComponents) {
    return components.map((component, index) => ({
      id: component.id,
      kind: component.statement_id
        ? "statement_component"
        : "workbook_component",
      description: component.description ?? `Workbook amount ${index + 1}`,
      amountText: component.amount_text,
      currency:
        component.currency ?? cell.aggregate?.currency ?? "MXN",
      date: component.transaction_date ?? null,
      statementId: component.statement_id ?? null,
      statementName: component.statement_name ?? null,
      statementPath: component.statement_path ?? null,
      sourcePage: component.source_page ?? null,
      sourceLineStart: component.source_line_start ?? null,
      sourceLineEnd: component.source_line_end ?? null,
      rawText: component.raw_text ?? null,
      sourceAmountText: component.source_amount_text ?? null,
      matchConfidence: component.match_confidence ?? null,
      matchMethod: component.match_method ?? null,
      sourceRef: component.source_ref ?? cell.aggregate?.source_ref ?? null,
    }));
  }

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
        statementPath: statement?.source_relative_path ?? null,
        sourcePage: transaction.source_page ?? null,
        sourceLineStart: transaction.source_line_start ?? null,
        sourceLineEnd: transaction.source_line_end ?? null,
        rawText: transaction.raw_text ?? null,
        sourceAmountText: transaction.amount_text,
        matchConfidence: "canonical",
        matchMethod: "canonical_statement_transaction",
        sourceRef: null,
      };
    });

  if (transactions.length) return transactions;

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
    statementPath: null,
    sourcePage: null,
    sourceLineStart: null,
    sourceLineEnd: null,
    rawText: null,
    sourceAmountText: null,
    matchConfidence: null,
    matchMethod: null,
    sourceRef: component.source_ref ?? cell.aggregate?.source_ref ?? null,
  }));
}
