import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ledgerAccountName,
  ledgerAccountOwner,
} from "../app/account-display.mjs";
import { getCellBreakdown } from "../app/cell-breakdown.mjs";
import {
  accountAllowsManualEntry,
  accountEntryMode,
  deriveLedgerData,
  SOURCE_BALANCE_CATEGORY_LABELS,
} from "../app/derive-ledger.mjs";
import {
  createManualTransaction,
  deleteManualTransaction,
  updateManualTransaction,
} from "../app/manual-transactions.mjs";
import {
  ALL_LEDGER_ASSETS,
  ALL_LEDGER_OWNERS,
  filterLedgerAccounts,
  ledgerColumnFilterOptions,
  transactionAccountIdsForMonth,
  UNASSIGNED_LEDGER_OWNER,
} from "../app/ledger-column-filters.mjs";
import { money, signedMoney } from "../app/money.mjs";
import {
  statementReviewStatements,
  statementReviewTransactions,
} from "../app/statement-review.mjs";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("keeps account identity suffixes out of ledger display names", () => {
  assert.equal(
    ledgerAccountName({
      label: "Everyday account @owner USD",
      currency: "USD",
    }),
    "Everyday account",
  );
  assert.equal(
    ledgerAccountOwner({
      label: "Everyday account @owner USD",
      currency: "USD",
    }),
    "@owner",
  );
  assert.equal(
    ledgerAccountName({
      label: "Travel · @partner · EUR",
      currency: "EUR",
    }),
    "Travel",
  );
  assert.equal(
    ledgerAccountOwner({
      label: "Travel · @partner · EUR",
      currency: "EUR",
    }),
    "@partner",
  );
  assert.equal(
    ledgerAccountName({
      label: "Wallet @owner $",
      currency: "$",
    }),
    "Wallet",
  );
  assert.equal(
    ledgerAccountName({
      label: "USD savings account",
      currency: "USD",
    }),
    "USD savings account",
  );
  assert.equal(
    ledgerAccountOwner({
      label: "USD savings account",
      currency: "USD",
      owner_label: "Household",
    }),
    "Household",
  );
});

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

test("uses invite-only encrypted CloudKit sharing without a site data binding", async () => {
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
  assert.match(cloudkit, /sharedCloudDatabase/);
  assert.match(cloudkit, /saveRecordZones\(LEDGER_ZONE_NAME\)/);
  assert.match(cloudkit, /shareWithUI/);
  assert.match(cloudkit, /supportedAccess:\s*\["PRIVATE"\]/);
  assert.match(cloudkit, /supportedPermissions:\s*\["READ_WRITE"\]/);
  assert.match(cloudkit, /isEncrypted:\s*true/);
  assert.match(
    cloudkit,
    /const ENCRYPTED_CHUNK_BYTES = 24_000/,
  );
  assert.match(cloudkit, /const CLOUDKIT_RECORD_BATCH_SIZE = 10/);
  assert.match(cloudkit, /fetchRequiredRecords/);
  assert.match(cloudkit, /saveRecordsInBatches/);
  assert.match(cloudkit, /parent: \{ recordName: LEDGER_RECORD_NAME \}/);
  assert.match(cloudkit, /isEncryptedValueDeserialization/);
  assert.match(cloudkit, /LEGACY_LEDGER_RECORD_NAME/);
  assert.match(cloudkit, /LEGACY_LEDGER_ZONE_NAME = "OurFinancesLedgerV1"/);
  assert.match(cloudkit, /LEDGER_RECORD_NAME = "ledger-v3"/);
  assert.match(cloudkit, /LEDGER_ZONE_NAME = "OurFinancesLedgerV3"/);
  assert.match(cloudkit, /rebuildRecoveredLedger/);
  assert.match(cloudkit, /for \(let attempt = 0; attempt < 4/);
  assert.match(cloudkit, /waitForRecoveryRetry/);
  assert.match(cloudkit, /fetchRequiredRecord/);
  assert.match(
    cloudkit,
    /if \(isEncryptedValueDeserialization\(error\)\) return \[\]/,
  );
  assert.doesNotMatch(cloudkit, /MAX_COMPRESSED_PAYLOAD_BYTES/);
  assert.doesNotMatch(cloudkit, /MAX_ENCODED_PAYLOAD_BYTES/);
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
  const emptyState = app.indexOf('{isEmpty && tab !== "sharing" ? (');
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
  assert.match(schema, /Candidate bundles repeat `unparsed_money_lines\[\]`/);
});

test("requires exact visual statement verification before import", async () => {
  const [skill, importer, validator, ledger, schema] = await Promise.all([
    source(".agents/skills/import-financial-statement/SKILL.md"),
    source(
      ".agents/skills/import-financial-statement/scripts/statement_import.py",
    ),
    source(
      ".agents/skills/import-financial-statement/scripts/validate_import.py",
    ),
    source("app/ledger.ts"),
    source(
      ".agents/skills/import-financial-statement/references/canonical-schema.md",
    ),
  ]);

  assert.match(skill, /render every page/i);
  assert.match(skill, /Verify every transaction individually/i);
  assert.doesNotMatch(skill, /Compare at least five transactions/i);
  assert.match(importer, /--visual-review/);
  assert.match(importer, /build_clean_statements/);
  assert.match(importer, /all_money_lines_classified/);
  assert.match(importer, /verified_transaction_ids/);
  assert.match(importer, /parse_cash_app_bitcoin_csv/);
  assert.match(importer, /gross amount \+ fee = net amount/);
  assert.match(importer, /unexpected asset amount/);
  assert.match(validator, /clean statement transactions do not match/);
  assert.match(validator, /every transaction ID must be visually verified/);
  assert.match(ledger, /predates visual completeness verification/);
  assert.match(ledger, /Every statement date range must be visually verified/);
  assert.match(ledger, /visual review must identify every verified transaction/i);
  assert.match(schema, /"date_range"/);
  assert.match(schema, /"starting_balance"/);
  assert.match(schema, /"transactions"/);
  assert.match(schema, /"ending_balance"/);
});

test("formats asset-denominated ledger cells without crashing", () => {
  assert.equal(money(1.23456789, "AVAX"), "1.23456789 AVAX");
  assert.equal(signedMoney(-1.25, "AVAX"), "−1.25 AVAX");
  assert.equal(money(0.00000001, "BTC"), "0.00000001 BTC");
  assert.match(money(12.5, "USD"), /\$12\.50/);
});

test("filters monthly ledger account columns without filtering cell contents", () => {
  const accounts = [
    {
      id: "liam-usd",
      label: "Card @Liam USD",
      currency: "USD",
      asset_symbol: null,
    },
    {
      id: "mar-btc",
      label: "Wallet @Mar BTC",
      currency: "BTC",
      asset_symbol: "BTC",
    },
    {
      id: "shared-usd",
      label: "Cash USD",
      currency: "USD",
      asset_symbol: null,
    },
  ];
  const transactions = [
    {
      id: "liam-june",
      account_id: "liam-usd",
      budget_month: "2026-06",
    },
    {
      id: "mar-evidence",
      account_id: "mar-btc",
      budget_month: "2026-06",
      ledger_role: "evidence_only",
    },
    {
      id: "mar-july",
      account_id: "mar-btc",
      transaction_date: "2026-07-02",
    },
  ];
  const juneAccountIds = transactionAccountIdsForMonth(
    transactions,
    "2026-06",
  );
  const options = ledgerColumnFilterOptions(accounts);

  assert.deepEqual(options.assets, ["BTC", "USD"]);
  assert.deepEqual(options.owners, ["@Liam", "@Mar"]);
  assert.equal(options.hasUnassignedOwner, true);
  assert.deepEqual(
    filterLedgerAccounts(accounts, {
      asset: "USD",
      owner: ALL_LEDGER_OWNERS,
      transactionAccountIds: juneAccountIds,
    }).map((account) => account.id),
    ["liam-usd", "shared-usd"],
  );
  assert.deepEqual(
    filterLedgerAccounts(accounts, {
      asset: ALL_LEDGER_ASSETS,
      owner: "@Liam",
      transactionsOnly: true,
      transactionAccountIds: juneAccountIds,
    }).map((account) => account.id),
    ["liam-usd"],
  );
  assert.deepEqual(
    filterLedgerAccounts(accounts, {
      owner: UNASSIGNED_LEDGER_OWNER,
      transactionAccountIds: juneAccountIds,
    }).map((account) => account.id),
    ["shared-usd"],
  );
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
  assert.equal(
    SOURCE_BALANCE_CATEGORY_LABELS.has("ACTUAL ENDING BALANCE"),
    true,
  );
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
      {
        id: "corroborating-evidence",
        account_id: "account-demo",
        category_id: "category-demo",
        transaction_date: "2026-06-06",
        amount_text: "-999",
        currency: "USD",
        source_kind: "statement",
        ledger_role: "evidence_only",
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
        source_kind: "statement",
        source_ref: "May statement closing balance",
        verification_status: "pass",
      },
      {
        id: "closing",
        account_id: "account-demo",
        as_of_date: "2026-06-30",
        balance_text: "65",
        currency: "USD",
        balance_kind: "closing",
        source_kind: "statement",
        source_ref: "June statement closing balance",
        verification_status: "pass",
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
  const actualStarting = cells.find(
    (item) => item.label === "ACTUAL STARTING BALANCE",
  );
  const calculatedEnding = cells.find(
    (item) => item.label === "ENDING BALANCE",
  );
  const actualEnding = cells.find(
    (item) => item.label === "ACTUAL ENDING BALANCE",
  );
  assert.equal(actualStarting?.source_ref, "May statement closing balance");
  assert.equal(actualStarting?.verification_status, "pass");
  assert.equal(actualStarting?.formula, null);
  assert.match(actualStarting?.id ?? "", /^source:balance:/);
  assert.equal(calculatedEnding?.source_ref, "derived formula");
  assert.equal(calculatedEnding?.verification_status, "derived");
  assert.equal(actualEnding?.source_ref, "June statement closing balance");
  assert.equal(actualEnding?.verification_status, "pass");
  assert.equal(actualEnding?.formula, null);
  assert.match(actualEnding?.id ?? "", /^source:balance:/);
  assert.equal(data.aggregates.some((item) => item.id === "obsolete"), false);
});

test("values fiat and asset accounts using Price Lookups semantics", () => {
  const data = deriveLedgerData({
    accounts: [
      {
        id: "usd-account",
        label: "USD account",
        currency: "USD",
      },
      {
        id: "eur-account",
        label: "EUR account",
        currency: "EUR",
      },
      {
        id: "asset-account",
        label: "Asset account",
        currency: "ACME",
        asset_symbol: "ACME",
      },
    ],
    categories: [
      {
        id: "income",
        label: "Salary",
        group_name: "income",
        sort_order: 10,
      },
      {
        id: "spending",
        label: "Groceries",
        group_name: "spending",
        sort_order: 11,
      },
      {
        id: "system",
        label: "INVESTMENT BUY/SELL",
        group_name: "system",
        sort_order: 5,
      },
      {
        id: "excluded",
        label: "Wedding",
        group_name: "spending",
        sort_order: 36,
      },
    ],
    transactions: [
      {
        id: "income-row",
        account_id: "usd-account",
        category_id: "income",
        transaction_date: "2026-06-01",
        amount_text: "10",
        currency: "USD",
      },
      {
        id: "spending-row",
        account_id: "eur-account",
        category_id: "spending",
        transaction_date: "2026-06-02",
        amount_text: "-5",
        currency: "EUR",
      },
      {
        id: "asset-row",
        account_id: "asset-account",
        category_id: "system",
        transaction_date: "2026-06-03",
        amount_text: "0.5",
        currency: "ACME",
      },
      {
        id: "excluded-row",
        account_id: "usd-account",
        category_id: "excluded",
        transaction_date: "2026-06-04",
        amount_text: "-3",
        currency: "USD",
      },
    ],
    balances: [],
    prices: [
      {
        symbol: "USD",
        kind: "cash_bill_count",
        quote_currency: "USD",
        value_text: "2",
      },
      {
        symbol: "USD",
        kind: "cash_bill_value",
        quote_currency: "MXN",
        value_text: "34",
      },
      {
        symbol: "USD",
        kind: "cash_bill_value",
        quote_currency: "USD",
        value_text: "2",
      },
      {
        symbol: "EUR",
        kind: "cash_coin_count",
        quote_currency: "EUR",
        value_text: "2",
      },
      {
        symbol: "EUR",
        kind: "cash_coin_value",
        quote_currency: "MXN",
        value_text: "40",
      },
      {
        symbol: "EUR",
        kind: "cash_coin_value",
        quote_currency: "USD",
        value_text: "2.4",
      },
      {
        symbol: "ACME",
        kind: "stock",
        quote_currency: "USD",
        value_text: "100",
      },
    ],
    statements: [],
    issues: [],
    aggregates: [],
  });
  const summaries = new Map(
    data.aggregates
      .filter((item) => item.kind === "month_summary")
      .map((item) => [item.label, item]),
  );
  assert.equal(Number(summaries.get("income")?.amount_mxn_text), 170);
  assert.equal(Number(summaries.get("spending")?.amount_mxn_text), -100);
  assert.equal(Number(summaries.get("market")?.amount_mxn_text), 850);
  assert.equal(Number(summaries.get("net")?.amount_mxn_text), 920);
  assert.equal(Number(summaries.get("net")?.amount_usd_text), 54);

  const wedding = data.aggregates.find(
    (item) =>
      item.kind === "category_summary" && item.category_id === "excluded",
  );
  assert.equal(Number(wedding?.amount_mxn_text), -51);
  assert.equal(Number(wedding?.amount_usd_text), -3);
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
      {
        id: "statement-demo",
        label: "Statement demo",
        currency: "USD",
        entry_mode: "statement",
        manual_periods: ["2026-07"],
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
  assert.equal(
    accountAllowsManualEntry(base.accounts[1], "2026-07"),
    true,
  );
  assert.equal(
    accountAllowsManualEntry(base.accounts[1], "2026-06"),
    false,
  );
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
  const provisional = createManualTransaction(base, {
    accountId: "statement-demo",
    categoryId: "category-demo",
    transactionDate: "2026-07-04",
    description: "Awaiting statement",
    amountText: "-5",
  });
  assert.equal(provisional.transaction.source_kind, "manual");
  assert.throws(
    () =>
      createManualTransaction(base, {
        accountId: "statement-demo",
        categoryId: "category-demo",
        transactionDate: "2026-06-04",
        description: "Not a manual period",
        amountText: "-5",
      }),
    /manually managed account/,
  );
});
