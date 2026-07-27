import { accountEntryMode } from "./derive-ledger.mjs";

export function createManualTransaction(data, input) {
  const checked = validateInput(data, input);
  const now = new Date().toISOString();
  const transaction = {
    id: `manual_${crypto.randomUUID()}`,
    statement_id: null,
    account_id: checked.account.id,
    category_id: checked.category.id,
    transaction_date: checked.transactionDate,
    posted_date: null,
    budget_month: checked.transactionDate.slice(0, 7),
    date_precision: "day",
    description: checked.description,
    amount_text: checked.amountText,
    currency: checked.account.currency,
    transaction_type: "manual",
    category_confidence: "1",
    categorization_source: "user",
    review_status: "reviewed",
    source_kind: "manual",
    fee_text: null,
    balance_text: null,
    quantity_text: null,
    unit_price_text: null,
    symbol: null,
    external_id: null,
    source_page: null,
    source_line_start: null,
    source_line_end: null,
    raw_text: null,
    source_amount_text: checked.amountText,
    match_confidence: "manual",
    notes: checked.notes,
    created_at: now,
    updated_at: now,
    reviewed_at: now,
  };
  return {
    data: {
      ...data,
      transactions: [...data.transactions, transaction],
    },
    transaction,
  };
}

export function updateManualTransaction(data, transactionId, input) {
  const existing = data.transactions.find((item) => item.id === transactionId);
  if (!existing) throw new Error("Manual transaction not found");
  if (existing.source_kind !== "manual") {
    throw new Error("Statement transactions can only change category");
  }
  const checked = validateInput(data, input);
  let updated;
  const transactions = data.transactions.map((item) => {
    if (item.id !== transactionId) return item;
    updated = {
      ...item,
      account_id: checked.account.id,
      category_id: checked.category.id,
      transaction_date: checked.transactionDate,
      budget_month: checked.transactionDate.slice(0, 7),
      description: checked.description,
      amount_text: checked.amountText,
      source_amount_text: checked.amountText,
      currency: checked.account.currency,
      notes: checked.notes,
      updated_at: new Date().toISOString(),
    };
    return updated;
  });
  return { data: { ...data, transactions }, transaction: updated };
}

export function deleteManualTransaction(data, transactionId) {
  const existing = data.transactions.find((item) => item.id === transactionId);
  if (!existing) throw new Error("Manual transaction not found");
  if (existing.source_kind !== "manual") {
    throw new Error("Statement transactions cannot be deleted");
  }
  return {
    ...data,
    transactions: data.transactions.filter((item) => item.id !== transactionId),
  };
}

function validateInput(data, input) {
  const account = data.accounts.find((item) => item.id === input.accountId);
  if (!account || accountEntryMode(account) !== "manual") {
    throw new Error("Choose a manually managed account");
  }
  const category = data.categories.find((item) => item.id === input.categoryId);
  if (!category || isFormulaCategory(category.label)) {
    throw new Error("Choose a transaction category");
  }
  const description = String(input.description ?? "").trim();
  if (!description) throw new Error("Description is required");
  const transactionDate = String(input.transactionDate ?? "").trim();
  if (!isIsoDate(transactionDate)) throw new Error("Enter a valid date");
  const amountText = String(input.amountText ?? "").trim();
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(amountText)) {
    throw new Error("Enter a signed amount");
  }
  const amount = Number(amountText);
  if (!Number.isFinite(amount)) throw new Error("Enter a signed amount");
  return {
    account,
    category,
    description,
    transactionDate,
    amountText,
    notes: String(input.notes ?? "").trim() || null,
  };
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isFormulaCategory(label) {
  return new Set([
    "ACTUAL STARTING BALANCE",
    "TOTAL CHANGE",
    "ENDING BALANCE",
    "ACTUAL ENDING BALANCE",
    "ERROR",
  ]).has(label);
}
