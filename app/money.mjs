/**
 * Format fiat currencies with the browser's locale-aware currency formatter.
 * Asset symbols such as AVAX are not ISO 4217 currency codes, so they fall
 * back to a precise amount followed by the original unit.
 *
 * @param {number} value
 * @param {string} [currency]
 */
export function money(value, currency = "MXN") {
  const unit = currency.trim();
  const normalizedUnit = unit.toUpperCase();
  const supportedCurrencies =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("currency")
      : ["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "MXN", "USD"];

  if (!supportedCurrencies.includes(normalizedUnit)) {
    return formatAssetAmount(value, unit);
  }

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedUnit,
      maximumFractionDigits: normalizedUnit === "MXN" ? 0 : 2,
    }).format(value);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return formatAssetAmount(value, unit);
  }
}

function formatAssetAmount(value, unit) {
  const amount = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 12,
  }).format(value);
  return unit ? `${amount} ${unit}` : amount;
}

/**
 * @param {number} value
 * @param {string} [currency]
 */
export function signedMoney(value, currency = "MXN") {
  if (value === 0) return money(0, currency);
  return `${value > 0 ? "+" : "−"}${money(Math.abs(value), currency)}`;
}
