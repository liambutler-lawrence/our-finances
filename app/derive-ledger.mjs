const FORMULA_DEFINITIONS = [
  {
    label: "ACTUAL STARTING BALANCE",
    id: "system_actual_starting_balance",
    sortOrder: 2,
    kind: "actual_starting_balance",
  },
  {
    label: "TOTAL CHANGE",
    id: "system_total_change",
    sortOrder: 900,
    kind: "total_change",
  },
  {
    label: "ENDING BALANCE",
    id: "system_ending_balance",
    sortOrder: 901,
    kind: "ending_balance",
  },
  {
    label: "ACTUAL ENDING BALANCE",
    id: "system_actual_ending_balance",
    sortOrder: 902,
    kind: "actual_ending_balance",
  },
  {
    label: "ERROR",
    id: "system_balance_error",
    sortOrder: 903,
    kind: "balance_error",
  },
];

export const FORMULA_CATEGORY_LABELS = new Set(
  FORMULA_DEFINITIONS.map((item) => item.label),
);

export const SOURCE_BALANCE_CATEGORY_LABELS = new Set([
  "ACTUAL STARTING BALANCE",
  "ACTUAL ENDING BALANCE",
]);

const MONTH_SUMMARY_EXCLUDED_LABELS = new Set([
  "BODA",
  "WEDDING",
  "WEDDING DONATIONS",
  "HONEYMOON",
  "HONEYMOON ACTIVIDADES",
  "HONEYMOON ACTIVITIES",
]);

export function accountEntryMode(account) {
  if (account?.entry_mode === "manual" || account?.entry_mode === "statement") {
    return account.entry_mode;
  }
  return /^(Efectivo|In Transit|Work Debt)\b/i.test(account?.label ?? "")
    ? "manual"
    : "statement";
}

export function transactionMonth(transaction) {
  if (
    typeof transaction?.budget_month === "string" &&
    /^\d{4}-\d{2}$/.test(transaction.budget_month)
  ) {
    return transaction.budget_month;
  }
  const date = transaction?.transaction_date ?? transaction?.posted_date;
  return typeof date === "string" && /^\d{4}-\d{2}/.test(date)
    ? date.slice(0, 7)
    : null;
}

export function deriveLedgerData(source) {
  const categories = ensureFormulaCategories(source.categories ?? []);
  const categoryById = new Map(categories.map((item) => [item.id, item]));
  const accounts = source.accounts ?? [];
  const accountById = new Map(accounts.map((item) => [item.id, item]));
  const transactions = (source.transactions ?? []).filter(
    (item) =>
      transactionMonth(item) &&
      item.category_id &&
      categoryById.has(item.category_id) &&
      !FORMULA_CATEGORY_LABELS.has(
        categoryById.get(item.category_id)?.label ?? "",
      ),
  );
  const balances = source.balances ?? [];
  const priceBook = buildPriceBook(source.prices ?? []);
  const cells = new Map();
  const activeAccountMonths = new Set();

  for (const transaction of transactions) {
    const month = transactionMonth(transaction);
    const account = accountById.get(transaction.account_id);
    const category = categoryById.get(transaction.category_id);
    if (!month || !account || !category) continue;
    const amount = finiteNumber(transaction.amount_text);
    if (amount === null) continue;
    const currency = transaction.currency || account.currency || "MXN";
    const converted = convertAccountAmount(amount, account, priceBook);
    const key = `${month}:${category.id}:${account.id}`;
    const current = cells.get(key);
    cells.set(key, {
      id: `derived:cell:${key}`,
      month,
      kind: "cell",
      account_id: account.id,
      category_id: category.id,
      label: category.label,
      amount_text: decimalText(numberOrZero(current?.amount_text) + amount),
      currency,
      amount_mxn_text: decimalText(
        numberOrZero(current?.amount_mxn_text) + converted.mxn,
      ),
      amount_usd_text: decimalText(
        numberOrZero(current?.amount_usd_text) + converted.usd,
      ),
      source_ref: "canonical transactions",
      verification_status:
        current?.verification_status === "derived_with_source_gaps" ||
        transaction.source_kind === "source_gap"
          ? "derived_with_source_gaps"
          : "derived_from_transactions",
    });
    activeAccountMonths.add(`${month}:${account.id}`);
  }

  for (const balance of balances) {
    if (balance.balance_kind === "opening") continue;
    const month = String(balance.as_of_date ?? "").slice(0, 7);
    if (month && accountById.has(balance.account_id)) {
      activeAccountMonths.add(`${month}:${balance.account_id}`);
    }
  }

  const formulaByLabel = new Map(
    FORMULA_DEFINITIONS.map((item) => [
      item.label,
      {
        ...item,
        category: categories.find((category) => category.label === item.label),
      },
    ]),
  );
  const transactionsByAccountMonth = new Map();
  for (const transaction of transactions) {
    const month = transactionMonth(transaction);
    if (!month) continue;
    const key = `${month}:${transaction.account_id}`;
    const rows = transactionsByAccountMonth.get(key) ?? [];
    rows.push(transaction);
    transactionsByAccountMonth.set(key, rows);
  }

  for (const activeKey of activeAccountMonths) {
    const separator = activeKey.indexOf(":");
    const month = activeKey.slice(0, separator);
    const accountId = activeKey.slice(separator + 1);
    const account = accountById.get(accountId);
    if (!account) continue;
    const accountTransactions =
      transactionsByAccountMonth.get(activeKey) ?? [];
    const startingSnapshot = latestBalanceBefore(balances, accountId, month);
    const actualEndingSnapshot = latestBalanceInMonth(
      balances,
      accountId,
      month,
    );
    const starting = finiteNumber(startingSnapshot?.balance_text) ?? 0;
    const totalChange = accountTransactions.reduce(
      (sum, item) => sum + (finiteNumber(item.amount_text) ?? 0),
      0,
    );
    const ending = starting + totalChange;
    const actualEnding = finiteNumber(actualEndingSnapshot?.balance_text);
    const hasSourceGap = accountTransactions.some(
      (item) => item.source_kind === "source_gap",
    );
    const formulaRows = [
      {
        label: "ACTUAL STARTING BALANCE",
        amount: starting,
        formula: "Latest balance snapshot before this month",
        sourceBalance: startingSnapshot ?? null,
      },
      {
        label: "TOTAL CHANGE",
        amount: totalChange,
        formula: "Sum of every transaction in this account and month",
      },
      {
        label: "ENDING BALANCE",
        amount: ending,
        formula: "Actual starting balance + total change",
      },
      ...(actualEnding === null
        ? []
        : [
            {
              label: "ACTUAL ENDING BALANCE",
              amount: actualEnding,
              formula: "Latest balance snapshot in this month",
              sourceBalance: actualEndingSnapshot,
            },
            {
              label: "ERROR",
              amount: ending - actualEnding,
              formula: "Ending balance − actual ending balance",
            },
          ]),
    ];

    for (const formulaRow of formulaRows) {
      const definition = formulaByLabel.get(formulaRow.label);
      if (!definition?.category) continue;
      const sourceBalance = formulaRow.sourceBalance ?? null;
      const converted = convertAccountAmount(
        formulaRow.amount,
        account,
        priceBook,
      );
      const key = `${month}:${definition.category.id}:${account.id}`;
      cells.set(key, {
        id: sourceBalance
          ? `source:balance:${definition.kind}:${month}:${account.id}:${sourceBalance.id}`
          : `derived:formula:${definition.kind}:${month}:${account.id}`,
        month,
        kind: "cell",
        formula_kind: definition.kind,
        formula: sourceBalance ? null : formulaRow.formula,
        account_id: account.id,
        category_id: definition.category.id,
        label: definition.label,
        amount_text: decimalText(formulaRow.amount),
        currency: account.currency,
        amount_mxn_text: decimalText(converted.mxn),
        amount_usd_text: decimalText(converted.usd),
        source_ref: sourceBalance?.source_ref ?? "derived formula",
        verification_status:
          sourceBalance?.verification_status ??
          (hasSourceGap ? "derived_with_source_gaps" : "derived"),
      });
    }
  }

  const cellRows = [...cells.values()];
  const categorySummaries = summarizeCategories(cellRows, categories);
  const monthSummaries = summarizeMonths(
    transactions,
    categories,
    accountById,
    priceBook,
  );
  const months = [
    ...new Set([
      ...transactions
        .map(transactionMonth)
        .filter((value) => typeof value === "string"),
      ...balances
        .filter((item) => item.balance_kind !== "opening")
        .map((item) => String(item.as_of_date ?? "").slice(0, 7))
        .filter((value) => /^\d{4}-\d{2}$/.test(value)),
    ]),
  ].sort();

  return {
    ...source,
    categories,
    aggregates: [...cellRows, ...categorySummaries, ...monthSummaries],
    months,
  };
}

function ensureFormulaCategories(categories) {
  const output = [...categories];
  for (const definition of FORMULA_DEFINITIONS) {
    if (output.some((item) => item.label === definition.label)) continue;
    output.push({
      id: definition.id,
      label: definition.label,
      group_name: "system",
      sort_order: definition.sortOrder,
      active: true,
    });
  }
  return output.sort(
    (left, right) =>
      Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0) ||
      String(left.label).localeCompare(String(right.label)),
  );
}

function summarizeCategories(cells, categories) {
  const categoryById = new Map(categories.map((item) => [item.id, item]));
  const summaries = new Map();
  for (const cell of cells) {
    if (!cell.category_id) continue;
    const key = `${cell.month}:${cell.category_id}`;
    const current = summaries.get(key);
    summaries.set(key, {
      id: `derived:category:${key}`,
      month: cell.month,
      kind: "category_summary",
      account_id: null,
      category_id: cell.category_id,
      label: categoryById.get(cell.category_id)?.label ?? cell.label,
      amount_text: null,
      currency: null,
      amount_mxn_text: decimalText(
        numberOrZero(current?.amount_mxn_text) +
          numberOrZero(cell.amount_mxn_text),
      ),
      amount_usd_text: decimalText(
        numberOrZero(current?.amount_usd_text) +
          numberOrZero(cell.amount_usd_text),
      ),
      source_ref: "derived formula",
      verification_status: "derived",
    });
  }
  return [...summaries.values()];
}

function summarizeMonths(transactions, categories, accountById, priceBook) {
  const categoryById = new Map(categories.map((item) => [item.id, item]));
  const totals = new Map();
  for (const transaction of transactions) {
    const month = transactionMonth(transaction);
    const category = categoryById.get(transaction.category_id);
    const account = accountById.get(transaction.account_id);
    const amount = finiteNumber(transaction.amount_text);
    if (!month || !category || !account || amount === null) continue;
    const converted = convertAccountAmount(amount, account, priceBook);
    const current = totals.get(month) ?? {
      income: { mxn: 0, usd: 0 },
      spending: { mxn: 0, usd: 0 },
      market: { mxn: 0, usd: 0 },
      net: { mxn: 0, usd: 0 },
    };
    if (
      MONTH_SUMMARY_EXCLUDED_LABELS.has(
        String(category.label ?? "").trim().toUpperCase(),
      )
    ) {
      totals.set(month, current);
      continue;
    }
    current.net.mxn += converted.mxn;
    current.net.usd += converted.usd;
    if (category.group_name === "income") {
      current.income.mxn += converted.mxn;
      current.income.usd += converted.usd;
    }
    if (category.group_name === "spending") {
      current.spending.mxn += converted.mxn;
      current.spending.usd += converted.usd;
    }
    if (category.group_name === "system") {
      current.market.mxn += converted.mxn;
      current.market.usd += converted.usd;
    }
    totals.set(month, current);
  }

  return [...totals].flatMap(([month, values]) =>
    Object.entries(values).map(([label, value]) => ({
      id: `derived:summary:${month}:${label}`,
      month,
      kind: "month_summary",
      account_id: null,
      category_id: null,
      label,
      amount_text: null,
      currency: null,
      amount_mxn_text: decimalText(value.mxn),
      amount_usd_text: decimalText(value.usd),
      source_ref: "derived formula",
      verification_status: "derived",
    })),
  );
}

function latestBalanceBefore(balances, accountId, month) {
  const monthStart = `${month}-01`;
  return balances
    .filter(
      (item) =>
        item.account_id === accountId &&
        typeof item.as_of_date === "string" &&
        item.as_of_date < monthStart,
    )
    .sort((left, right) => right.as_of_date.localeCompare(left.as_of_date))[0];
}

function latestBalanceInMonth(balances, accountId, month) {
  const monthStart = `${month}-01`;
  const nextMonthStart = nextMonth(month);
  return balances
    .filter(
      (item) =>
        item.account_id === accountId &&
        typeof item.as_of_date === "string" &&
        item.as_of_date >= monthStart &&
        item.as_of_date < nextMonthStart,
    )
    .sort((left, right) => right.as_of_date.localeCompare(left.as_of_date))[0];
}

function nextMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber, 1));
  return date.toISOString().slice(0, 10);
}

function buildPriceBook(prices) {
  const quotesBySymbol = new Map();
  const cashGroups = new Map();

  const setQuote = (symbol, quoteCurrency, value, priority) => {
    if (!symbol || !["MXN", "USD"].includes(quoteCurrency)) return;
    const numericValue = finiteNumber(value);
    if (numericValue === null) return;
    const symbolKey = String(symbol).toUpperCase();
    const quotes = quotesBySymbol.get(symbolKey) ?? {};
    const current = quotes[quoteCurrency];
    if (!current || priority >= current.priority) {
      quotes[quoteCurrency] = { value: numericValue, priority };
    }
    quotesBySymbol.set(symbolKey, quotes);
  };

  for (const price of prices) {
    const symbol = String(price.symbol ?? "").toUpperCase();
    const kind = String(price.kind ?? "");
    if (["currency", "crypto", "stock"].includes(kind)) {
      setQuote(symbol, price.quote_currency, price.value_text, 3);
      continue;
    }
    const match = kind.match(/^cash_(bill|coin)_(count|value)$/);
    if (!match) continue;
    const groupKey = `${symbol}:${match[1]}`;
    const group = cashGroups.get(groupKey) ?? {
      symbol,
      count: null,
      values: {},
    };
    const value = finiteNumber(price.value_text);
    if (match[2] === "count" && price.quote_currency === symbol) {
      group.count = value;
    }
    if (
      match[2] === "value" &&
      ["MXN", "USD"].includes(price.quote_currency)
    ) {
      group.values[price.quote_currency] = value;
    }
    cashGroups.set(groupKey, group);
  }

  const cashTotals = new Map();
  for (const group of cashGroups.values()) {
    if (group.count === null || group.count === 0) continue;
    const totals = cashTotals.get(group.symbol) ?? {
      count: 0,
      values: { MXN: 0, USD: 0 },
    };
    totals.count += group.count;
    for (const quoteCurrency of ["MXN", "USD"]) {
      totals.values[quoteCurrency] += group.values[quoteCurrency] ?? 0;
    }
    cashTotals.set(group.symbol, totals);
  }

  for (const [symbol, totals] of cashTotals) {
    for (const quoteCurrency of ["MXN", "USD"]) {
      setQuote(
        symbol,
        quoteCurrency,
        totals.values[quoteCurrency] / totals.count,
        2,
      );
    }
  }

  setQuote("MXN", "MXN", 1, 4);
  setQuote("USD", "USD", 1, 4);

  const usdMxn =
    quotesBySymbol.get("USD")?.MXN?.value ??
    reciprocal(quotesBySymbol.get("MXN")?.USD?.value);
  const mxnUsd =
    quotesBySymbol.get("MXN")?.USD?.value ?? reciprocal(usdMxn);
  if (usdMxn !== null) setQuote("USD", "MXN", usdMxn, 4);
  if (mxnUsd !== null) setQuote("MXN", "USD", mxnUsd, 4);

  const completed = new Map();
  for (const [symbol, quotes] of quotesBySymbol) {
    let mxn = quotes.MXN?.value ?? null;
    let usd = quotes.USD?.value ?? null;
    if (mxn === null && usd !== null && usdMxn !== null) {
      mxn = usd * usdMxn;
    }
    if (usd === null && mxn !== null && mxnUsd !== null) {
      usd = mxn * mxnUsd;
    }
    completed.set(symbol, { mxn: mxn ?? 0, usd: usd ?? 0 });
  }
  return completed;
}

function convertAccountAmount(amount, account, priceBook) {
  const symbol = String(
    account?.asset_symbol || account?.currency || "MXN",
  ).toUpperCase();
  const quotes = priceBook.get(symbol);
  return {
    mxn: amount * (quotes?.mxn ?? 0),
    usd: amount * (quotes?.usd ?? 0),
  };
}

function reciprocal(value) {
  return value === null || value === undefined || value === 0 ? null : 1 / value;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value) {
  return finiteNumber(value) ?? 0;
}

function decimalText(value) {
  if (Object.is(value, -0) || Math.abs(value) < 1e-12) return "0";
  return String(value);
}
