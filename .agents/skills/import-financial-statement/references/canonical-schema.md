# Canonical statement import contract

## Files

For `<stem>`, emit:

- `<stem>.transactions.csv`: portable transaction table.
- `<stem>.bundle.json`: site import payload containing the manifest,
  transaction rows, and `unparsed_money_lines[]` page/line/text evidence.
- `<stem>.manifest.json`: human- and machine-readable reconciliation result.
- `<stem>.audit.json`: page text, source coverage, and unparsed source lines.

Schema version: `1.0.0`.

## Transaction fields

| Field | Requirement |
| --- | --- |
| `transaction_id` | Deterministic SHA-256-derived ID. |
| `statement_id` | Deterministic ID from the source SHA-256. |
| `account_section_id` | Stable ID for one account/currency section. |
| `institution` | Detected source institution. |
| `account_name` | Source account label; may be redacted in UI. |
| `account_last4` | Last four only when available. |
| `account_type` | `checking`, `savings`, `credit`, `brokerage`, `crypto`, `cash`, or `unknown`. |
| `period_start`, `period_end` | ISO dates when supplied. |
| `transaction_date`, `posted_date` | ISO dates; preserve both when distinct. |
| `description` | Source description without categorization edits. |
| `amount` | Exact signed decimal string in `currency`. |
| `currency` | ISO currency or asset symbol. |
| `direction` | `in`, `out`, or `neutral`. |
| `transaction_type` | Transfer/payment/purchase/fee/interest/trade/etc. |
| `category` | Suggested budget category. |
| `category_confidence` | Decimal from 0 to 1. |
| `categorization_source` | `rule`, `reviewed_mapping`, `source`, or `unknown`. |
| `review_status` | Initially `needs_review`; never auto-approve uncertain rows. |
| `fee` | Exact fee decimal when supplied. |
| `balance` | Running balance after the transaction when supplied. |
| `quantity`, `unit_price`, `symbol` | Preserve investment/crypto details. |
| `external_id` | Source transaction/reference ID when supplied. |
| `source_page` | One-based PDF page or CSV row group. |
| `source_line_start`, `source_line_end` | One-based extracted line bounds. |
| `raw_text` | Verbatim source block used for the record. |
| `notes` | Parser caveat; never a replacement for raw text. |

Blank optional fields are empty strings in CSV and `null` in JSON.

## Manifest

Record the source basename, SHA-256, page count, detected institution, parser
name/version, statement ID, sections, transaction count, exact signed totals,
warnings, duplicate status, and validation state.

Each section records its account label, last four, currency, period, opening
balance, closing balance, parsed activity total, computed closing balance,
difference, and status.

Validation states:

- `blocked`: extraction coverage or reconciliation failed.
- `ready_for_review`: lossless extraction and reconciliation passed.
- `ready_for_import`: every row is reviewed or accepted by the user.

## Audit

Store:

- `pages[]`: page number, complete extracted text, line count, extraction mode.
- `unparsed_money_lines[]`: page, line, and verbatim text.
- `ignored_money_lines[]`: known summaries/headings with an explicit reason.
- parser warnings and visual-review notes.

An unfamiliar money line is never ignored automatically.

The bundle repeats `unparsed_money_lines[]` so the private statement-review UI
can expose every unresolved source line without needing access to the local
audit file. The manifest count must equal the bundled evidence length.

## Reconciliation

Use exact decimal arithmetic.

For deposit/cash accounts:

`opening_balance + sum(amount) = closing_balance`

For credit cards, positive charges increase the balance and negative
payments/credits reduce it:

`previous_balance + sum(amount) + fees + interest = closing_balance`

For brokerage statements, reconcile cash activity separately from holdings.
Also reconcile supplied opening and closing net account values, but do not
invent a market-gain transaction to force the cash ledger to equal market
value.

Default tolerance is the smallest displayed currency unit: `0.01` for fiat.
Use the statement's displayed precision for assets.
