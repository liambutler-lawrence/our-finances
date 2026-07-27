# Budget category taxonomy

## System flows

- Transfers
- Credit card payments
- Investment buy/sell
- Work expenses
- Cash withdrawals

These affect account balances but are excluded from income/spending totals.

## Income

- Salary
- Gifts
- Interest / cashback / dividends

## Spending

- Rent
- Groceries
- Restaurants
- Therapy
- Phone & internet
- Pets
- Transportation
- Entertainment
- Doctors
- Productivity software
- Laundry
- Immigration
- Gym & personal care
- Events
- Fees & taxes
- Hobbies
- Utilities
- Insurance
- Clothes
- Maintenance
- School
- Electronics
- Donations
- News
- Wedding
- Honeymoon
- Honeymoon activities

## Review rules

- Match transfers, reversals, payments, trades, fees, and cash withdrawals
  before merchant rules.
- Use prior user-reviewed mappings before built-in rules.
- Do not treat a transfer or credit-card payment as spending.
- Keep refunds in the original spending category with a positive signed amount.
- Use `Needs review` below 0.8 confidence or when two rules conflict.
