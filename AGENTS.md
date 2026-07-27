# Repository instructions

- Never commit personal financial data, account identifiers, statement files,
  exported workbooks, generated statement bundles, or database contents.
- When a task includes a bank, card, brokerage, crypto, or cash statement, use
  `.agents/skills/import-financial-statement/SKILL.md`.
- Preserve exact source amounts and raw source text. Do not force
  reconciliation, discard unrecognized money lines, or silently repair source
  discrepancies.
- Keep the application UI a pure function of protected data. Add new displays
  as source-controlled features.
- `gh` may report erroneous authentication failures in the sandbox; run GitHub
  CLI operations outside the sandbox when required.
