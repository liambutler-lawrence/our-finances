# Our Finances

Our Finances is a statement-first household budget. It replaces a monthly
spreadsheet ledger with a repeatable pipeline:

1. Extract every transaction from a statement into a lossless canonical
   bundle.
2. Reconcile the extracted activity against the statement.
3. Review suggested categories in the app.
4. Derive the monthly ledger, totals, balances, and charts from protected data.

The application source is public and contains **no household financial data**.

## Privacy model

Each person signs in with Apple and gets a separate ledger in that Apple ID's
CloudKit private database. A friend who signs into the same site gets their own
empty ledger, not the site owner's data.

- The browser talks directly to CloudKit; the application server does not
  receive statement contents, transactions, balances, or exports.
- The ledger is compressed into an encrypted CloudKit field in the user's
  private database, with a SHA-256 integrity digest.
- CloudKit isolates private database records by Apple account. Apple Advanced
  Data Protection provides the strongest available end-to-end protection for
  eligible iCloud data.
- There is no shared application database, server-side financial-data store,
  owner allowlist, or master account.
- Users can export the complete private ledger as JSON and every canonical
  transaction as CSV at any time.
- Original PDFs remain in the user's private document storage.
- Local imports, statement files, spreadsheets, and generated bundles are
  excluded by `.gitignore`.

The CloudKit web API token is public browser configuration, not a server
credential. Restrict it to the production origin in CloudKit Console and pass
it through deployment environment configuration; never add a server-to-server
key to this repository.

Do not add real statement samples, screenshots containing balances, exported
workbooks, generated import bundles, or database contents to commits, issues,
or pull requests.

## Statement import skill

The project skill lives at
`.agents/skills/import-financial-statement/SKILL.md`. In a new Codex task in
this repository, provide a PDF or CSV statement and ask to import it. The skill
will:

- hash the original;
- visually inspect every PDF page;
- preserve exact source amounts, raw text, and source coordinates;
- emit deterministic canonical CSV and JSON;
- retain fees, balances, quantities, symbols, and identifiers;
- suggest categories without auto-approving uncertainty;
- reconcile account sections independently; and
- block import readiness when money-bearing source lines are unaccounted for.

Generated files default to `.private/imports/` and must remain private. Import
the generated JSON bundle through **Data & prices** in the app, then review or
change every proposed category.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set these browser configuration values in `.env.local`:

```dotenv
NEXT_PUBLIC_CLOUDKIT_CONTAINER_IDENTIFIER=iCloud.com.example.OurFinances
NEXT_PUBLIC_CLOUDKIT_API_TOKEN=your-domain-restricted-web-token
NEXT_PUBLIC_CLOUDKIT_ENVIRONMENT=development
```

Useful checks:

```bash
npm run lint
npm test
```

## CloudKit setup

The current schema uses a `FinanceLedger` record in the private database:

| Field | CloudKit type |
| --- | --- |
| `payload` | Encrypted Bytes |
| `schemaVersion` | String |
| `digest` | String |
| `updatedAt` | Date/Time |

Create separate domain-restricted web tokens for Development and Production.
Promote schema changes through CloudKit Console before switching
`NEXT_PUBLIC_CLOUDKIT_ENVIRONMENT` to `production`.

## Architecture

- Next.js-compatible app router via vinext
- Cloudflare Worker runtime with no financial-data binding
- CloudKit JS and Sign in with Apple
- Per-user CloudKit private database
- Client-side canonical import, category review, derivation, and export

The monthly UI is a pure view of canonical transactions, balance snapshots,
and price snapshots. Total change, starting balance, ending balance, and
balance error are recalculated from those inputs every time. No monthly cell or
formula result is stored as an aggregate.

Statement-backed transactions preserve their source file, page, line, raw
text, and exact source amount. Their amount and description are read-only in
the app; category is the reviewable field. Cash, in-transit, and work-debt
accounts use the manual account ledger, where transactions can be added,
edited, or deleted directly.

Historical amounts that are not yet tied to a statement line are canonical
`source_gap` transactions. They remain visible in totals and the review queue
without being misrepresented as source-backed. Completing the statement
backfill replaces those gaps with reconciled source records.

## Import contracts

Two private JSON formats are accepted:

- `1.0.0` canonical statement bundles produced by the repository skill.
- `our-finances-v2` full-ledger migrations containing canonical transactions,
  balance snapshots, prices, statements, and audit findings. This format
  explicitly replaces the private ledger and never accepts stored aggregates.

Imports are idempotent by stable record IDs. The CSV export includes exact
source amounts, dates, raw text, coordinates, metadata, categories, and review
status.

## License

MIT
