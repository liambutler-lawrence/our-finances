import { ledgerAccountOwner } from "./account-display.mjs";
import { transactionMonth } from "./derive-ledger.mjs";

export const ALL_LEDGER_ASSETS = "__all_assets__";
export const ALL_LEDGER_OWNERS = "__all_owners__";
export const UNASSIGNED_LEDGER_OWNER = "__unassigned_owner__";

export function ledgerColumnAsset(account) {
  return String(account?.asset_symbol || account?.currency || "").trim();
}

export function ledgerColumnOwner(account) {
  return ledgerAccountOwner(account);
}

export function ledgerColumnFilterOptions(accounts) {
  const assets = new Set();
  const owners = new Set();
  let hasUnassignedOwner = false;

  for (const account of accounts ?? []) {
    const asset = ledgerColumnAsset(account);
    const owner = ledgerColumnOwner(account);
    if (asset) assets.add(asset);
    if (owner) owners.add(owner);
    else hasUnassignedOwner = true;
  }

  return {
    assets: [...assets].sort((a, b) => a.localeCompare(b)),
    owners: [...owners].sort((a, b) => a.localeCompare(b)),
    hasUnassignedOwner,
  };
}

export function transactionAccountIdsForMonth(transactions, month) {
  return new Set(
    (transactions ?? [])
      .filter(
        (transaction) =>
          transaction.ledger_role !== "evidence_only" &&
          transactionMonth(transaction) === month,
      )
      .map((transaction) => transaction.account_id),
  );
}

export function filterLedgerAccounts(
  accounts,
  {
    asset = ALL_LEDGER_ASSETS,
    owner = ALL_LEDGER_OWNERS,
    transactionsOnly = false,
    transactionAccountIds = new Set(),
  } = {},
) {
  return (accounts ?? []).filter((account) => {
    if (
      asset !== ALL_LEDGER_ASSETS &&
      ledgerColumnAsset(account) !== asset
    ) {
      return false;
    }

    const accountOwner = ledgerColumnOwner(account);
    if (
      owner !== ALL_LEDGER_OWNERS &&
      (owner === UNASSIGNED_LEDGER_OWNER
        ? accountOwner
        : accountOwner !== owner)
    ) {
      return false;
    }

    return !transactionsOnly || transactionAccountIds.has(account.id);
  });
}
