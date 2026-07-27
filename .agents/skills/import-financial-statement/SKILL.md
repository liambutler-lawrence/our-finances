---
name: import-financial-statement
description: Convert bank, credit-card, brokerage, payment-app, savings, and multi-currency statement PDFs or CSVs into the Our Finances canonical import bundle. Use for new monthly statements, backfills, statement reconciliation, transaction extraction, categorization, duplicate detection, or preparing data for the statement-review UI.
---

# Import Financial Statement

Produce a lossless, auditable import bundle. Parsing is not complete merely
because plausible transactions were found; source coverage and reconciliation
must also pass.

## Workflow

1. Keep the source outside version control. Never copy a statement, extracted
   text, bundle, or real transaction sample into tracked files.
2. Hash the source before processing. Use the hash as the duplicate guard.
3. For PDFs, render every page or every distinct layout plus all transaction
   pages. Visually compare the render with extracted text; do not trust text
   extraction alone.
4. Run:

   ```bash
   python .agents/skills/import-financial-statement/scripts/statement_import.py \
     path/to/statement.pdf \
     --output-dir .private/imports
   ```

5. Read the generated manifest and audit file. Inspect every warning and every
   `unparsed_money_line`.
6. Compare at least five transactions across the beginning, middle, and end of
   each account section. Check dates, descriptions, signs, decimal separators,
   fees, balances, quantities, prices, and page locators.
7. Run:

   ```bash
   python .agents/skills/import-financial-statement/scripts/validate_import.py \
     .private/imports/<statement>.bundle.json
   ```

8. Categorize only after extraction is stable. Preserve the original
   description, amount, currency, and raw source line when changing a category.
9. Import the bundle through the site's review queue. Do not mark a statement
   reviewed while reconciliation fails or source money lines remain unparsed.

## Completion gates

Require all of the following:

- The source SHA-256 is recorded.
- Every page has extracted text or an explicit image-only warning.
- Every account section and currency is represented.
- Every transaction-like source line is parsed or listed verbatim in the audit
  file with a page and line number.
- Opening balance + signed activity = closing balance within the currency
  tolerance whenever the statement supplies both balances.
- Statement-level totals, fees, payments, interest, and holdings reconcile when
  present.
- Temporary authorizations, reversals, transfers, credit-card payments, and
  investment buys/sells remain distinct records.
- The validator reports `ready_for_review`; `ready_for_import` is allowed only
  after category review.

If a gate fails, return the partial bundle and a concise discrepancy list. Do
not silently invent a balancing transaction, merge away a reversal, or discard
an unfamiliar line.

## Parsing rules

- Treat a PDF containing multiple accounts or periods as multiple sections in
  one statement, not as one blended account.
- Preserve the source's sign semantics. For credit cards, charges increase the
  card balance and payments reduce it. For asset accounts, buys reduce cash and
  increase holdings; keep both the cash amount and quantity/price fields.
- Store exact decimal text and a normalized decimal. Never round source values
  to make a reconciliation pass.
- Use deterministic IDs so re-importing the same source is idempotent.
- Classify internal transfers as `Transfers`; classify credit-card payments as
  `Credit card payments`; neither is spending.
- Put uncertain classifications in `Needs review` with confidence below 0.8.
- Prefer a specific source parser when detected. The generic parser is a
  recovery path and must never be treated as automatically complete.

## Canonical contract

Read [references/canonical-schema.md](references/canonical-schema.md) before
changing the script, adding an institution parser, or preparing an import by
hand. Keep the site importer and validator compatible with that contract.

The importer currently recognizes Apple Card, Wise, Nu, Cash App, Capital One,
Robinhood, and generic delimited transaction CSVs. Unsupported layouts still
produce a lossless audit artifact and a blocked partial bundle.

## Categorization

Use the taxonomy in
[references/category-taxonomy.md](references/category-taxonomy.md). Merchant
rules suggest categories; they never overwrite a user's reviewed category.
When a prior reviewed description mapping is available from the site export,
prefer it and record `categorization_source=reviewed_mapping`.

## Privacy

- `.private/` is the only allowed repository-local output area.
- Do not include names, account numbers, addresses, emails, statement text, or
  transaction values in tests, fixtures, documentation, commits, or chat
  summaries unless the user explicitly asks for a private discrepancy detail.
- Redact account identifiers in ordinary progress messages. Preserve them only
  inside the private bundle where reconciliation needs them.
- Before uploading a bundle to a hosted service, confirm the destination and
  that the user authorized sending the financial data there.
