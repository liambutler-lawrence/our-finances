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

test("protects data routes and exposes the canonical import skill", async () => {
  const [financeRoute, importRoute, exportRoute, skill] = await Promise.all([
    source("app/api/finance/route.ts"),
    source("app/api/import/route.ts"),
    source("app/api/export/route.ts"),
    source(".agents/skills/import-financial-statement/SKILL.md"),
  ]);
  for (const route of [financeRoute, importRoute, exportRoute]) {
    assert.match(route, /requireApiUser/);
    assert.match(route, /Unauthorized/);
  }
  assert.match(importRoute, /our-finances-legacy-v1/);
  assert.match(importRoute, /schema_version/);
  assert.match(skill, /lossless/i);
  assert.match(skill, /reconcil/i);
  assert.match(skill, /unparsed_money_line/);
});
