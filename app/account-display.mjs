export function ledgerAccountName(account) {
  const original = String(account?.label ?? "").trim();
  if (!original) return "";

  const currency = String(account?.currency ?? "").trim();
  const withoutCurrency = currency
    ? stripTrailingToken(original, currency)
    : original;
  const display = withoutCurrency.replace(ownerSuffixPattern(), "").trim();

  return display || original;
}

export function ledgerAccountOwner(account) {
  const original = String(account?.label ?? "").trim();
  const currency = String(account?.currency ?? "").trim();
  const withoutCurrency = currency
    ? stripTrailingToken(original, currency)
    : original;
  const match = withoutCurrency.match(ownerSuffixPattern(true));
  return match?.[1] ?? (String(account?.owner_label ?? "").trim() || null);
}

function ownerSuffixPattern(capture = false) {
  const owner = capture
    ? "(@[\\p{L}\\p{N}_-]+)"
    : "@[\\p{L}\\p{N}_-]+";
  return new RegExp(`(?:\\s*[-–—|·/]\\s*|\\s+)${owner}\\s*$`, "u");
}

function stripTrailingToken(value, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value
    .replace(
      new RegExp(
        `(?:\\s*[-–—|·/]\\s*|\\s+|\\s*\\()${escaped}\\)?\\s*$`,
        "i",
      ),
      "",
    )
    .trim();
}
