import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getCellBreakdown } from "../app/cell-breakdown.mjs";
import {
  accountEntryMode,
  deriveLedgerData,
} from "../app/derive-ledger.mjs";
import {
  createManualTransaction,
  deleteManualTransaction,
  updateManualTransaction,
} from "../app/manual-transactions.mjs";
import { money, signedMoney } from "../app/money.mjs";
import {
  statementReviewStatements,
  statementReviewTransactions,
} from "../app/statement-review.mjs";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("keeps private financial artifacts out of Git", async () => {
  const gitignore = await source(".gitignore");
  for (const pattern of [
    "/.private/",
    "*.numbers",
    "*.xlsx",
    "*.transactions.csv",
    "*.bundle.json",
    "*.audit.json",
  ]) {
    assert.match(gitignore, new RegExp(pattern.replaceAll("*", "\\*")));
  }
});

test("uses per-user private CloudKit without a shared data binding", async () => {
  const [hosting, cloudkit, ledger, skill] = await Promise.all([
    source(".openai/hosting.json"),
    source("app/cloudkit.ts"),
    source("app/ledger.ts"),
    source(".agents/skills/import-financial-statement/SKILL.md"),
  ]);
  const bindings = JSON.parse(hosting);
  assert.equal(bindings.d1, null);
  assert.equal(bindings.r2, null);
  assert.match(cloudkit, /privateCloudDatabase/);
  assert.match(cloudkit, /isEncrypted:\s*true/);
  assert.match(cloudkit, /NEXT_PUBLIC_CLOUDKIT_ENVIRONMENT \?\? "production"/);
  assert.doesNotMatch(cloudkit, /publicCloudDatabase/);
  assert.doesNotMatch(cloudkit, /serverToServer/);
  assert.match(ledger, /our-finances-v2/);
  assert.match(ledger, /schema_version/);
  assert.match(ledger, /raw_text/);
  assert.match(ledger, /source_line_start/);
  assert.match(skill, /lossless/i);
  assert.match(skill, /reconcil/i);
  assert.match(skill, /unparsed_money_line/);
});

test("keeps CloudKit deployment values out of tracked configuration", async () => {
  const [gitignore, example] = await Promise.all([
    source(".gitignore"),
    source(".env.example"),
  ]);
  assert.match(gitignore, /\.env\*/);
  assert.match(example, /replace-with-domain-restricted-browser-token/);
  assert.doesNotMatch(example, /iCloud\.com\.liambutlerlawrence/);
});

test("keeps the private import input mounted for an empty ledger", async () => {
  const app = await source("app/FinanceApp.tsx");
  const input = app.indexOf('accept=".json,application/json"');
  const emptyState = app.indexOf("{isEmpty ? (");
  assert.ok(input > -1);
  assert.ok(emptyState > -1);
  assert.ok(input < emptyState);
});

test("exports both the complete ledger and lossless transaction CSV", async () => {
  const [shell, app, ledger] = await Promise.all([
    source("app/CloudKitFinance.tsx"),
    source("app/FinanceApp.tsx"),
    source("app/ledger.ts"),
  ]);
  assert.match(shell, /our-finances-ledger\.json/);
  assert.match(shell, /JSON\.stringify\(ledgerRef\.current\?\.data/);
  assert.match(shell, /our-finances-transactions\.csv/);
  assert.match(app, /aria-label="Full private ledger JSON"/);
  assert.match(app, /value=\{onReadLedger\(\)\}/);
  assert.match(ledger, /raw_text/);
  assert.match(ledger, /source_line_start/);
});

test("carries unparsed money-line evidence into the private review UI", async () => {
  const [importer, validator, ledger, app, schema] = await Promise.all([
    source(
      ".agents/skills/import-financial-statement/scripts/statement_import.py",
    ),
    source(
      ".agents/skills/import-financial-statement/scripts/validate_import.py",
    ),
    source("app/ledger.ts"),
    source("app/FinanceApp.tsx"),
    source(
      ".agents/skills/import-financial-statement/references/canonical-schema.md",
    ),
  ]);

  assert.match(importer, /"unparsed_money_lines": audit\["unparsed_money_lines"\]/);
  assert.match(validator, /unparsed_money_line_count does not match evidence/);
  assert.match(ledger, /unparsed_money_lines: sourceUnparsedLines/);
  assert.match(app, /UnparsedLinesPanel/);
  assert.match(app, /Page \{item\.page\} · line \{item\.line\}/);
  assert.match(schema, /bundle repeats `unparsed_money_lines\[\]`/);
});

test("formats asset-denominated ledger cells without crashing", () => {
  assert.equal(money(1.23456789, "AVAX"), "1.23456789 AVAX");
  assert.equal(signedMoney(-1.25, "AVAX"), "−1.25 AVAX");
  assert.equal(money(0.00000001, "BTC"), "0.00000001 BTC");
  assert.match(money(12.5, "USD"), /\$12\.50/);
});

test("filters the statement review queue without exposing manual transactions", () => {
  const transactions = [
    {
      id: "statement-one-a",
      statement_id: "statement-one",
      source_kind: "statement",
    },
    {
      id: "statement-two-a",
      statement_id: "statement-two",
      source_kind: "statement",
    },
    {
      id: "source-gap",
      statement_id: null,
      source_kind: "source_gap",
    },
    {
      id: "manual",
      statement_id: null,
      source_kind: "manual",
    },
  ];

  assert.deepEqual(
    statementReviewTransactions(transactions).map((item) => item.id),
    ["statement-one-a", "statement-two-a", "source-gap"],
  );
  assert.deepEqual(
    statementReviewTransactions(transactions, "statement-one").map(
      (item) => item.id,
    ),
    ["statement-one-a"],
  );
  assert.deepEqual(
    statementReviewTransactions(transactions, "missing-statement"),
    [],
  );
});

test("combines month and statement filters using the ledger budget month", () => {
  const transactions = [
    {
      id: "june-budget",
      statement_id: "statement-one",
      source_kind: "statement",
      budget_month: "2026-06",
      transaction_date: "2026-05-29",
    },
    {
      id: "july-date",
      statement_id: "statement-one",
      source_kind: "statement",
      transaction_date: "2026-07-03",
    },
    {
      id: "june-gap",
      statement_id: null,
      source_kind: "source_gap",
      budget_month: "2026-06",
    },
  ];

  assert.deepEqual(
    statementReviewTransactions(transactions, null, "2026-06").map(
      (item) => item.id,
    ),
    ["june-budget", "june-gap"],
  );
  assert.deepEqual(
    statementReviewTransactions(
      transactions,
      "statement-one",
      "2026-06",
    ).map((item) => item.id),
    ["june-budget"],
  );
});

test("shows statements linked to the month or whose period ends in it", () => {
  const statements = [
    {
      id: "linked",
      period_start: "2026-05-01",
      period_end: "2026-05-31",
    },
    {
      id: "overlapping",
      period_start: "2026-05-20",
      period_end: "2026-06-19",
    },
    {
      id: "july",
      period_start: "2026-07-01",
      period_end: "2026-07-31",
    },
  ];
  const transactions = [
    {
      id: "linked-june",
      statement_id: "linked",
      source_kind: "statement",
      budget_month: "2026-06",
    },
  ];

  assert.deepEqual(
    statementReviewStatements(statements, transactions, "2026-06").map(
      (item) => item.id,
    ),
    ["linked", "overlapping"],
  );
});

test("prefers statement transactions for ledger cell breakdowns", () => {
  const items = getCellBreakdown(
    {
      statements: [
        {
          id: "statement-demo",
          source_basename: "sample-statement.pdf",
        },
      ],
      transactions: [
        {
          id: "transaction-one",
          statement_id: "statement-demo",
          account_id: "account-demo",
          category_id: "category-demo",
          transaction_date: "2026-06-04",
          description: "Example merchant",
          amount_text: "-12.34",
          currency: "USD",
          source_page: 2,
          source_line_start: 10,
          source_line_end: 11,
          raw_text: "Example source line",
        },
      ],
    },
    {
      aggregate: {
        components: [
          {
            id: "obsolete-one",
            amount_text: "-12.34",
            currency: "USD",
          },
        ],
      },
      month: "2026-06",
      accountId: "account-demo",
      categoryId: "category-demo",
    },
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "statement_transaction");
  assert.equal(items[0].statementName, "sample-statement.pdf");
  assert.equal(items[0].sourcePage, 2);
  assert.equal(items[0].rawText, "Example source line");
});

test("never falls back to obsolete aggregate components", () => {
  const items = getCellBreakdown(
    { statements: [], transactions: [], balances: [] },
    {
      aggregate: {
        currency: "MXN",
        components: [
          {
            id: "obsolete-one",
            amount_text: "-100",
            currency: "MXN",
            description: "Workbook amount 1",
            source_ref: "Budget workbook · June 2025 · B12",
          },
          {
            id: "obsolete-two",
            amount_text: "-25",
            currency: "MXN",
            description: "Workbook amount 2",
            source_ref: "Budget workbook · June 2025 · B12",
          },
        ],
      },
      month: "2025-06",
      accountId: "account-demo",
      categoryId: "category-demo",
    },
  );

  assert.deepEqual(items, []);
});

test("distinguishes manual transactions and unresolved source gaps", () => {
  const items = getCellBreakdown(
    {
      statements: [],
      balances: [],
      transactions: [
        {
          id: "manual-one",
          statement_id: null,
          account_id: "account-demo",
          category_id: "category-demo",
          transaction_date: "2026-06-04",
          description: "Cash purchase",
          amount_text: "-42.5",
          currency: "USD",
          source_kind: "manual",
        },
        {
          id: "gap-one",
          statement_id: null,
          account_id: "account-demo",
          category_id: "category-demo",
          transaction_date: "2026-06-05",
          description: "Historical source gap",
          amount_text: "-7.5",
          currency: "USD",
          source_kind: "source_gap",
        },
      ],
    },
    {
      aggregate: { currency: "USD" },
      month: "2025-06",
      accountId: "account-demo",
      categoryId: "category-demo",
    },
  );

  assert.equal(items.length, 0);

  const juneItems = getCellBreakdown(
    {
      statements: [],
      balances: [],
      transactions: [
        {
          id: "manual-one",
          statement_id: null,
          account_id: "account-demo",
          category_id: "category-demo",
          transaction_date: "2026-06-04",
          description: "Cash purchase",
          amount_text: "-42.5",
          currency: "USD",
          source_kind: "manual",
        },
        {
          id: "gap-one",
          statement_id: null,
          account_id: "account-demo",
          category_id: "category-demo",
          transaction_date: "2026-06-05",
          description: "Historical source gap",
          amount_text: "-7.5",
          currency: "USD",
          source_kind: "source_gap",
        },
      ],
    },
    {
      aggregate: { currency: "USD" },
      month: "2026-06",
      accountId: "account-demo",
      categoryId: "category-demo",
    },
  );
  assert.deepEqual(
    juneItems.map((item) => item.kind),
    ["manual_transaction", "source_gap"],
  );
});

test("derives monthly cells and balance formulas from transactions and snapshots", () => {
  const data = deriveLedgerData({
    accounts: [
      {
        id: "account-demo",
        label: "Example account",
        currency: "USD",
        entry_mode: "statement",
      },
    ],
    categories: [
      {
        id: "category-demo",
        label: "Groceries",
        group_name: "spending",
        sort_order: 10,
      },
    ],
    transactions: [
      {
        id: "transaction-one",
        account_id: "account-demo",
        category_id: "category-demo",
        transaction_date: "2026-06-04",
        amount_text: "-25",
        currency: "USD",
        source_kind: "statement",
      },
      {
        id: "transaction-two",
        account_id: "account-demo",
        category_id: "category-demo",
        transaction_date: "2026-06-05",
        amount_text: "-10",
        currency: "USD",
        source_kind: "statement",
      },
    ],
    balances: [
      {
        id: "opening",
        account_id: "account-demo",
        as_of_date: "2026-05-31",
        balance_text: "100",
        currency: "USD",
        balance_kind: "opening",
      },
      {
        id: "closing",
        account_id: "account-demo",
        as_of_date: "2026-06-30",
        balance_text: "65",
        currency: "USD",
        balance_kind: "closing",
      },
    ],
    prices: [],
    statements: [],
    issues: [],
    aggregates: [
      {
        id: "obsolete",
        month: "2026-06",
        kind: "cell",
        amount_text: "999",
      },
    ],
  });
  const cells = data.aggregates.filter(
    (item) =>
      item.kind === "cell" &&
      item.account_id === "account-demo" &&
      item.month === "2026-06",
  );
  const value = (label) =>
    Number(cells.find((item) => item.label === label)?.amount_text);
  assert.equal(value("Groceries"), -35);
  assert.equal(value("ACTUAL STARTING BALANCE"), 100);
  assert.equal(value("TOTAL CHANGE"), -35);
  assert.equal(value("ENDING BALANCE"), 65);
  assert.equal(value("ACTUAL ENDING BALANCE"), 65);
  assert.equal(value("ERROR"), 0);
  assert.equal(data.aggregates.some((item) => item.id === "obsolete"), false);
});

test("manual account transactions can be added, edited, and deleted", () => {
  const base = {
    accounts: [
      {
        id: "cash-demo",
        label: "Cash demo",
        currency: "USD",
        entry_mode: "manual",
      },
    ],
    categories: [
      {
        id: "category-demo",
        label: "Groceries",
        group_name: "spending",
      },
    ],
    transactions: [],
  };
  assert.equal(accountEntryMode(base.accounts[0]), "manual");
  const created = createManualTransaction(base, {
    accountId: "cash-demo",
    categoryId: "category-demo",
    transactionDate: "2026-06-04",
    description: "Market",
    amountText: "-12.50",
  });
  assert.equal(created.transaction.source_kind, "manual");
  const updated = updateManualTransaction(
    created.data,
    created.transaction.id,
    {
      accountId: "cash-demo",
      categoryId: "category-demo",
      transactionDate: "2026-06-05",
      description: "Market corrected",
      amountText: "-10",
    },
  );
  assert.equal(updated.transaction.description, "Market corrected");
  const deleted = deleteManualTransaction(
    updated.data,
    created.transaction.id,
  );
  assert.equal(deleted.transactions.length, 0);
});
