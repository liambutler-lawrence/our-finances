---
name: import-financial-statement
description: Visually verify and convert bank, credit-card, brokerage, payment-app, savings, and multi-currency statement PDFs or CSVs into exact Our Finances canonical import bundles. Use for new monthly statements, backfills, statement reconciliation, complete transaction extraction, categorization, duplicate detection, or preparing data for the statement-review UI.
---

# Import Financial Statement

Produce a lossless, visually verified import bundle. Extraction and
categorization have different confidence standards: every source fact must be
exact, while suggested budget categories may remain editable.

## Workflow

1. Keep the source outside version control. Never copy a statement, extracted
   text, bundle, or real transaction sample into tracked files.
2. Hash the source before processing. Use the hash as the duplicate guard.
3. For PDFs, render every page. Inspect the rendered pages yourself with the
   image/PDF viewing tools available in the thread. Do not treat OCR, extracted
   text, tables, regular expressions, or parser output as visual verification.
4. Run:

   ```bash
   python .agents/skills/import-financial-statement/scripts/statement_import.py \
     path/to/statement.pdf \
     --output-dir .private/imports
   ```

5. Treat the first result as a candidate extraction. Read its manifest and
   audit, then compare it against every rendered page from top to bottom.
6. Establish, for every account/currency section:

   - the exact date range;
   - whether a starting balance is present and its exact value;
   - every transaction, in source order, with every available field;
   - whether an ending balance is present and its exact value.

7. Verify every transaction individually, including multiline descriptions,
   dates, posted dates, signs, decimal separators, currencies, fees, running
   balances, quantities, prices, symbols, IDs, and page/line locators. Record
   each statement-supplied opening/closing asset position as a separate balance
   control, preserving only the quantity/value fields actually printed. A
   plausible count or sample check is not sufficient.
8. Resolve every money-bearing line decisively as a transaction, balance,
   statement total, disclosure, rate, holding, or other non-transaction. If a
   genuine transaction was missed, improve the parser or add the complete
   private record and rerun. Do not leave a “maybe transaction” row.
9. Write a private visual-review record following
   [references/canonical-schema.md](references/canonical-schema.md), then rerun:

   ```bash
   python .agents/skills/import-financial-statement/scripts/statement_import.py \
     path/to/statement.pdf \
     --output-dir .private/imports \
     --visual-review .private/imports/<statement>.visual-review.json
   ```

10. Run:

   ```bash
   python .agents/skills/import-financial-statement/scripts/validate_import.py \
     .private/imports/<statement>.bundle.json
   ```

11. Categorize only after extraction is exact. Preserve all source fields when
    changing a category. `Needs review` is valid for categorization; it is not
    valid for whether a source row is a transaction.
12. Import only a validator-approved bundle. The site rejects candidate,
    unreviewed, ambiguous, or unreconciled bundles.

## Completion gates

Require all of the following:

- The source SHA-256 is recorded.
- Every PDF page was rendered and visually inspected by the agent.
- The visual-review page list exactly matches the PDF page list.
- Every account section and currency is represented.
- Date range, starting-balance presence/value, every transaction, and
  ending-balance presence/value are visually verified against source evidence.
- Every money-bearing source line has one definitive classification.
- `unparsed_money_lines[]` is empty in an importable bundle.
- Opening balance + signed activity = closing balance within the currency
  tolerance whenever the statement supplies both balances.
- Statement-level totals, fees, payments, interest, and holdings reconcile when
  present. Every supplied per-symbol closing position is preserved as a
  verified balance control rather than inferred from transaction activity.
- Temporary authorizations, reversals, transfers, credit-card payments, and
  investment buys/sells remain distinct records.
- The clean `statements[]` structure contains `date_range`,
  `starting_balance`, `transactions`, and `ending_balance` for every section.
- The validator reports `ready_for_review`; `ready_for_import` is allowed only
  after category review.

If a gate fails, keep the candidate bundle and audit privately and report the
precise blocker. A candidate is diagnostic evidence, not an importable output.
Do not invent a balancing transaction, merge away a reversal, discard an
unfamiliar line, or ask the user to resolve an ambiguity that careful source
inspection can settle.

## Parsing rules

- Treat a PDF containing multiple accounts or periods as multiple sections in
  one statement, not as one blended account.
- Preserve the source's transaction/operation date as `transaction_date` and a
  distinct charge/posting/application date as `posted_date`. Never substitute a
  statement folder, nominal month, period end, or posting date for a printed
  operation date.
- Calendar-month ledger placement is derived from `transaction_date`, even when
  one statement period crosses a month boundary. A statement spanning May and
  June must contribute its May-dated and June-dated transactions to different
  budget months. Use `posted_date` only when the source genuinely omits an
  operation date.
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
  recovery path and can pass only after complete visual verification and
  explicit resolution of its warning.

## Canonical contract

Read [references/canonical-schema.md](references/canonical-schema.md) before
changing the script, adding an institution parser, or preparing an import by
hand. Keep the site importer and validator compatible with that contract.

The importer currently recognizes Apple Card, Wise, Nu, Cash App, Capital One,
Robinhood, and generic delimited transaction CSVs. Unsupported layouts still
produce a lossless candidate audit and a blocked bundle.

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
