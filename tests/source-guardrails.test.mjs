import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
