# Canonical statement import contract

## Files

For `<stem>`, emit:

- `<stem>.transactions.csv`: portable transaction table.
- `<stem>.bundle.json`: candidate or importable payload containing the manifest,
  clean statement sections, transaction rows, and unresolved evidence.
- `<stem>.manifest.json`: human- and machine-readable reconciliation result.
- `<stem>.audit.json`: page text, source coverage, and unparsed source lines.
- `<stem>.visual-review.json`: private agent-authored source verification used
  to turn a candidate extraction into an importable bundle.

Schema version: `1.1.0`.

## Clean statement structure

`bundle.statements[]` contains one object per account/currency section:

```json
{
  "account_section_id": "deterministic section ID",
  "account": {
    "name": "source account label",
    "last4": null,
    "type": "checking",
    "currency": "USD"
  },
  "date_range": {
    "start": "YYYY-MM-DD",
    "end": "YYYY-MM-DD",
    "source_page": 1,
    "source_line_start": 1,
    "source_line_end": 1,
    "raw_text": "verbatim source evidence",
    "verification_status": "verified"
  },
  "starting_balance": {
    "included": true,
    "amount": "exact decimal text",
    "currency": "USD",
    "source_page": 1,
    "source_line_start": 1,
    "source_line_end": 1,
    "raw_text": "verbatim source evidence",
    "verification_status": "verified"
  },
  "positions": [
    {
      "symbol": "BTC",
      "description": "Bitcoin",
      "opening_quantity": null,
      "closing_quantity": "0.12345678",
      "unit_price": null,
      "market_value": "12345.67",
      "currency": "BTC",
      "source_page": 1,
      "source_line_start": 1,
      "source_line_end": 1,
      "raw_text": "verbatim source evidence",
      "verification_status": "verified"
    }
  ],
  "transactions": [],
  "ending_balance": {
    "included": true,
    "amount": "exact decimal text",
    "currency": "USD",
    "source_page": 1,
    "source_line_start": 1,
    "source_line_end": 1,
    "raw_text": "verbatim source evidence",
    "verification_status": "verified"
  }
}
```

When a balance is not present, use `included=false`, `amount=null`, and
`verification_status=verified_absent`. Absence must be confirmed from the
rendered source; it is not the same as parser failure. The four source elements
must never contain tentative records.

`positions[]` is optional and contains exact statement-supplied holding
quantities. Preserve only fields printed by the source: do not derive a unit
price merely because quantity and market value are available. A complete
holdings table is an ending-balance control for each listed asset. When the
source supplies an opening quantity, preserve that separately. Positions are
not transactions and must not be added to cash activity.

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
| `transaction_date`, `posted_date` | ISO dates; `transaction_date` is the printed transaction/operation date and governs calendar-month ledger placement. Preserve a distinct posting/application date as `posted_date`; never replace the operation date with the statement period end. |
| `description` | Source description without categorization edits. |
| `amount` | Exact signed decimal string in `currency`. |
| `currency` | ISO currency or asset symbol. |
| `direction` | `in`, `out`, or `neutral`. |
| `transaction_type` | Transfer/payment/purchase/fee/interest/trade/etc. |
| `category` | Suggested budget category. |
| `category_confidence` | Decimal from 0 to 1. |
| `categorization_source` | `rule`, `reviewed_mapping`, `source`, or `needs_review`. |
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
- `ready_for_review`: exact extraction, complete visual verification, and
  reconciliation passed; categories may still need review.
- `ready_for_import`: every row is reviewed or accepted by the user.

## Visual review

Run the parser once without this file to obtain section IDs, transaction counts,
warnings, and page evidence. After visually inspecting every rendered page,
create the private review record:

```json
{
  "source_sha256": "full source hash",
  "reviewer": "Codex",
  "reviewed_at": "ISO-8601 timestamp",
  "reviewed_pages": [1],
  "all_money_lines_classified": true,
  "resolved_warnings": [],
  "sections": [
    {
      "account_section_id": "section ID from the candidate manifest",
      "date_range": {
        "start": "YYYY-MM-DD",
        "end": "YYYY-MM-DD",
        "source_page": 1,
        "source_line_start": 1,
        "source_line_end": 1,
        "raw_text": "verbatim source evidence",
        "verified": true
      },
      "starting_balance": {
        "included": false,
        "amount": null,
        "source_page": null,
        "source_line_start": null,
        "source_line_end": null,
        "raw_text": null,
        "verified": true
      },
      "positions_verified": true,
      "verified_positions": [],
      "transactions_verified": true,
      "transaction_count": 0,
      "verified_transaction_ids": [],
      "ending_balance": {
        "included": false,
        "amount": null,
        "source_page": null,
        "source_line_start": null,
        "source_line_end": null,
        "raw_text": null,
        "verified": true
      }
    }
  ]
}
```

List every rendered PDF page explicitly. `resolved_warnings` must contain every
parser warning verbatim after visual resolution. List every verified transaction
ID explicitly in its statement section; a count alone is not evidence of
transaction-by-transaction review. When the section has holdings, set
`positions_verified=true` and list every exact position control—including its
symbol, opening/closing quantities, source locator, and raw text—in
`verified_positions[]`. A visual assertion cannot override an
unparsed money line, a reconciliation failure, a missing date range, or a
disagreement with the parsed balances or transactions.

## Audit

Store:

- `pages[]`: page number, complete extracted text, line count, extraction mode.
- `unparsed_money_lines[]`: page, line, and verbatim text.
- `ignored_money_lines[]`: known summaries/headings with an explicit reason.
- parser warnings and visual-review notes.

An unfamiliar money line is never imported, ignored, or left tentative
automatically. Inspect it visually and either parse it as a complete transaction
or classify it definitively as a non-transaction source element.

Candidate bundles repeat `unparsed_money_lines[]` for diagnosis. Importable
bundles require an empty array, and the manifest count must match it.

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
