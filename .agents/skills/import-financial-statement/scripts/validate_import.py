#!/usr/bin/env python3
"""Validate an Our Finances canonical statement bundle."""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

REQUIRED_TRANSACTION_FIELDS = {
    "transaction_id",
    "statement_id",
    "account_section_id",
    "description",
    "amount",
    "currency",
    "source_page",
    "source_line_start",
    "raw_text",
    "review_status",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    errors: list[str] = []
    manifest = bundle.get("manifest") or {}
    transactions = bundle.get("transactions")
    unparsed_money_lines = bundle.get("unparsed_money_lines")
    if bundle.get("schema_version") != "1.0.0":
        errors.append("unsupported schema_version")
    if not isinstance(transactions, list):
        errors.append("transactions must be an array")
        transactions = []
    ids: set[str] = set()
    for index, transaction in enumerate(transactions, 1):
        missing = REQUIRED_TRANSACTION_FIELDS - transaction.keys()
        if missing:
            errors.append(f"transaction {index} missing {sorted(missing)}")
        tx_id = transaction.get("transaction_id")
        if tx_id in ids:
            errors.append(f"duplicate transaction_id {tx_id}")
        ids.add(tx_id)
        try:
            Decimal(str(transaction.get("amount")))
        except (InvalidOperation, TypeError):
            errors.append(f"transaction {index} has invalid amount")
        if not str(transaction.get("raw_text") or "").strip():
            errors.append(f"transaction {index} has empty raw_text")
    if manifest.get("transaction_count") != len(transactions):
        errors.append("manifest transaction_count does not match rows")
    if not isinstance(unparsed_money_lines, list):
        errors.append("unparsed_money_lines must be an array")
        unparsed_money_lines = []
    if manifest.get("unparsed_money_line_count") != len(unparsed_money_lines):
        errors.append("manifest unparsed_money_line_count does not match evidence")
    for index, item in enumerate(unparsed_money_lines, 1):
        if not isinstance(item, dict):
            errors.append(f"unparsed money line {index} must be an object")
            continue
        if not isinstance(item.get("page"), int) or item["page"] < 1:
            errors.append(f"unparsed money line {index} has invalid page")
        if not isinstance(item.get("line"), int) or item["line"] < 1:
            errors.append(f"unparsed money line {index} has invalid line")
        if not str(item.get("text") or "").strip():
            errors.append(f"unparsed money line {index} has empty text")
    for section in manifest.get("sections", []):
        if section.get("status") == "fail":
            errors.append(
                f"reconciliation failed for section {section.get('account_section_id')}: "
                f"difference {section.get('difference')}"
            )
    if manifest.get("unparsed_money_line_count"):
        errors.append(
            f"{manifest['unparsed_money_line_count']} source money lines remain unparsed"
        )
    expected_state = "blocked" if errors else "ready_for_review"
    if manifest.get("validation_state") not in {expected_state, "ready_for_import"}:
        errors.append(
            f"validation_state is {manifest.get('validation_state')}, expected {expected_state}"
        )
    result = {
        "bundle": str(args.bundle),
        "transaction_count": len(transactions),
        "validation_state": "blocked" if errors else manifest.get("validation_state"),
        "errors": errors,
    }
    print(json.dumps(result, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
