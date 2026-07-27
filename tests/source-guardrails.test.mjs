import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { money, signedMoney } from "../app/money.mjs";

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
  assert.match(ledger, /our-finances-legacy-v1/);
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
  const [shell, ledger] = await Promise.all([
    source("app/CloudKitFinance.tsx"),
    source("app/ledger.ts"),
  ]);
  assert.match(shell, /our-finances-ledger\.json/);
  assert.match(shell, /JSON\.stringify\(ledgerRef\.current\?\.data/);
  assert.match(shell, /our-finances-transactions\.csv/);
  assert.match(ledger, /raw_text/);
  assert.match(ledger, /source_line_start/);
});

test("formats asset-denominated ledger cells without crashing", () => {
  assert.equal(money(1.23456789, "AVAX"), "1.23456789 AVAX");
  assert.equal(signedMoney(-1.25, "AVAX"), "−1.25 AVAX");
  assert.equal(money(0.00000001, "BTC"), "0.00000001 BTC");
  assert.match(money(12.5, "USD"), /\$12\.50/);
});
