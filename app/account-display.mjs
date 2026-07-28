export function ledgerAccountName(account) {
  const original = String(account?.label ?? "").trim();
  if (!original) return "";

  const currency = String(account?.currency ?? "").trim();
  let display = currency
    ? stripTrailingToken(original, currency)
    : original;
  display = display
    .replace(/(?:\s*[-–—|·/]\s*|\s+)@[\p{L}\p{N}_-]+\s*$/u, "")
    .trim();

  return display || original;
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
