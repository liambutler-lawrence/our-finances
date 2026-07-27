# Our Finances

Our Finances is a private, statement-first household budget. It replaces a
monthly spreadsheet ledger with a repeatable pipeline:

1. Extract every transaction from a statement into a lossless canonical
   bundle.
2. Reconcile the extracted activity against the statement.
3. Review suggested categories in the authenticated app.
4. Derive the monthly ledger, totals, balances, and charts from protected data.

The application source is intentionally public and contains **no household
financial data**.

## Privacy model

- Source code and database schema are public.
- Financial values, account labels, transactions, statement filenames, source
  text, and workbook history live only in a protected Sites D1 database.
- Original PDFs remain in the household's private document storage.
- Authenticated users can export canonical transaction data as CSV at any time.
- The first authenticated production user becomes the owner. Later,
  unrecognized users are denied by the application in addition to the hosting
  access policy.
- Private imports, local databases, spreadsheet files, statement files, and
  generated bundles are excluded by `.gitignore`.

Do not add real statement samples, screenshots containing balances, exported
workbooks, or generated import bundles to issues or pull requests.

## Statement import skill

The project skill lives at
`.agents/skills/import-financial-statement/SKILL.md`. In a new Codex task in
this repository, provide a PDF or CSV statement and ask to import it. The skill
will:

- hash the original;
- visually inspect every PDF page;
- preserve raw source text and source coordinates;
- emit a deterministic canonical CSV and JSON bundle;
- retain fees, balances, quantities, symbols, and identifiers;
- suggest budget categories without auto-approving uncertainty;
- reconcile account sections independently; and
- block import readiness when money-bearing source lines are unaccounted for.

Generated files default to `.private/imports/` and must remain private.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The local preview uses a local-only identity and local D1 state. It does not
contain production data.

Useful checks:

```bash
npm run lint
npm test
npm run db:generate
```

## Architecture

- Next.js-compatible app router via vinext
- Cloudflare Worker runtime
- Cloudflare D1-compatible relational data store
- Sign in with ChatGPT identity headers supplied by Sites
- Server-side owner allowlist
- Drizzle schema and generated SQL migrations

The monthly UI is a pure view of imported canonical statements, balance
snapshots, price snapshots, and preserved legacy workbook aggregates. Display
changes should be implemented as code rather than per-user layout
customization.

## Import contracts

Two private JSON formats are accepted:

- `1.0.0` canonical statement bundles produced by the repository skill.
- `our-finances-legacy-v1` migration bundles used to seed historical workbook
  aggregates, balances, prices, and audit findings.

Imports are idempotent by stable record IDs. The export endpoint returns every
canonical transaction as CSV with exact source amounts and review metadata.

## License

MIT
