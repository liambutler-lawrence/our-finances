#!/usr/bin/env python3
"""Validate an Our Finances canonical statement bundle."""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

REQUIRED_TRANSACTION_FIELDS = {
    "schema_version",
    "transaction_id",
    "statement_id",
    "account_section_id",
    "account_name",
    "institution",
    "account_type",
    "account_last4",
    "period_start",
    "period_end",
    "transaction_date",
    "posted_date",
    "description",
    "amount",
    "currency",
    "direction",
    "transaction_type",
    "category",
    "category_confidence",
    "categorization_source",
    "source_page",
    "source_line_start",
    "source_line_end",
    "raw_text",
    "review_status",
    "fee",
    "balance",
    "quantity",
    "unit_price",
    "symbol",
    "external_id",
    "notes",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    errors: list[str] = []
    manifest = bundle.get("manifest") or {}
    transactions = bundle.get("transactions")
    statements = bundle.get("statements")
    unparsed_money_lines = bundle.get("unparsed_money_lines")
    if bundle.get("schema_version") != "1.1.0":
        errors.append("unsupported schema_version")
    if not isinstance(transactions, list):
        errors.append("transactions must be an array")
        transactions = []
    ids: set[str] = set()
    for index, transaction in enumerate(transactions, 1):
        if not isinstance(transaction, dict):
            errors.append(f"transaction {index} must be an object")
            continue
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
        if not str(transaction.get("transaction_date") or "").strip():
            errors.append(f"transaction {index} has no transaction_date")
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
    visual_review = manifest.get("visual_review")
    if not isinstance(visual_review, dict):
        errors.append("visual review is missing")
    else:
        if visual_review.get("all_money_lines_classified") is not True:
            errors.append("visual review did not classify every money-bearing line")
        if not str(visual_review.get("reviewed_at") or "").strip():
            errors.append("visual review has no reviewed_at timestamp")
        if not str(visual_review.get("reviewer") or "").strip():
            errors.append("visual review has no reviewer")
        if visual_review.get("source_sha256") != manifest.get("source_sha256"):
            errors.append("visual review source hash does not match the statement")
        page_count = manifest.get("page_count")
        expected_pages = (
            list(range(1, page_count + 1))
            if isinstance(page_count, int) and page_count > 0
            else []
        )
        reviewed_pages = visual_review.get("reviewed_pages")
        if not isinstance(reviewed_pages, list) or sorted(reviewed_pages) != expected_pages:
            errors.append("visual review does not explicitly cover every source page")
        warnings = manifest.get("warnings")
        resolved_warnings = visual_review.get("resolved_warnings")
        if (
            not isinstance(warnings, list)
            or not isinstance(resolved_warnings, list)
            or sorted(resolved_warnings) != sorted(warnings)
        ):
            errors.append("visual review does not resolve every parser warning")
        visual_sections = visual_review.get("sections")
        manifest_sections = manifest.get("sections")
        if not isinstance(visual_sections, list):
            errors.append("visual review sections must be an array")
            visual_sections = []
        if not isinstance(manifest_sections, list):
            errors.append("manifest sections must be an array")
            manifest_sections = []
        if len(visual_sections) != len(manifest_sections):
            errors.append("every statement section must have one visual review")
        for section in manifest_sections:
            if not isinstance(section, dict):
                continue
            section_id = section.get("account_section_id")
            review_section = next(
                (
                    item
                    for item in visual_sections
                    if isinstance(item, dict)
                    and item.get("account_section_id") == section_id
                ),
                None,
            )
            section_transaction_ids = sorted(
                transaction.get("transaction_id")
                for transaction in transactions
                if isinstance(transaction, dict)
                and isinstance(transaction.get("transaction_id"), str)
                and transaction.get("account_section_id") == section_id
            )
            if not isinstance(review_section, dict):
                errors.append(f"visual review is missing section {section_id}")
                continue
            if review_section.get("transactions_verified") is not True:
                errors.append(f"transactions are not visually verified for {section_id}")
            if review_section.get("transaction_count") != len(
                section_transaction_ids
            ):
                errors.append(f"visual transaction count disagrees for {section_id}")
            if sorted(review_section.get("verified_transaction_ids") or []) != (
                section_transaction_ids
            ):
                errors.append(
                    f"every transaction ID must be visually verified for {section_id}"
                )
    visual_review_errors = manifest.get("visual_review_errors")
    if not isinstance(visual_review_errors, list):
        errors.append("manifest visual_review_errors must be an array")
    elif visual_review_errors:
        errors.extend(str(item) for item in visual_review_errors)
    if not isinstance(statements, list):
        errors.append("statements must be an array")
        statements = []
    if len(statements) != len(manifest.get("sections") or []):
        errors.append("clean statements do not match manifest sections")
    manifest_sections_by_id = {
        section.get("account_section_id"): section
        for section in (manifest.get("sections") or [])
        if isinstance(section, dict)
    }
    clean_section_ids: set[str] = set()
    clean_transaction_ids: list[str] = []
    for index, statement in enumerate(statements, 1):
        if not isinstance(statement, dict):
            errors.append(f"clean statement {index} must be an object")
            continue
        section_id = statement.get("account_section_id")
        if not isinstance(section_id, str) or not section_id:
            errors.append(f"clean statement {index} has no account_section_id")
            continue
        if section_id in clean_section_ids:
            errors.append(f"duplicate clean statement section {section_id}")
        clean_section_ids.add(section_id)
        manifest_section = manifest_sections_by_id.get(section_id)
        if not isinstance(manifest_section, dict):
            errors.append(f"clean statement {index} is missing from the manifest")
            continue
        date_range = statement.get("date_range")
        if not isinstance(date_range, dict):
            errors.append(f"clean statement {index} has no date_range")
        else:
            if not date_range.get("start") or not date_range.get("end"):
                errors.append(f"clean statement {index} has an incomplete date_range")
            if date_range.get("verification_status") != "verified":
                errors.append(f"clean statement {index} date_range is not verified")
            if not str(date_range.get("raw_text") or "").strip():
                errors.append(f"clean statement {index} date_range has no evidence")
            if (
                date_range.get("start") != manifest_section.get("period_start")
                or date_range.get("end") != manifest_section.get("period_end")
            ):
                errors.append(
                    f"clean statement {index} date_range disagrees with the manifest"
                )
        for field, manifest_field in (
            ("starting_balance", "opening_balance"),
            ("ending_balance", "closing_balance"),
        ):
            balance = statement.get(field)
            if not isinstance(balance, dict):
                errors.append(f"clean statement {index} has no {field}")
                continue
            if not isinstance(balance.get("included"), bool):
                errors.append(
                    f"clean statement {index} {field} has no exact presence flag"
                )
                continue
            expected_status = (
                "verified" if balance.get("included") is True else "verified_absent"
            )
            if balance.get("verification_status") != expected_status:
                errors.append(f"clean statement {index} {field} is not verified")
            if balance.get("included") is True:
                try:
                    Decimal(str(balance.get("amount")))
                except (InvalidOperation, TypeError):
                    errors.append(
                        f"clean statement {index} {field} has invalid amount"
                    )
                if not str(balance.get("raw_text") or "").strip():
                    errors.append(
                        f"clean statement {index} {field} has no source evidence"
                    )
            elif balance.get("amount") is not None:
                errors.append(
                    f"clean statement {index} absent {field} must have null amount"
                )
            manifest_amount = manifest_section.get(manifest_field)
            if balance.get("included") is not (manifest_amount is not None):
                errors.append(
                    f"clean statement {index} {field} presence disagrees "
                    "with the manifest"
                )
            elif manifest_amount is not None:
                try:
                    same_amount = Decimal(str(balance.get("amount"))) == Decimal(
                        str(manifest_amount)
                    )
                except (InvalidOperation, TypeError):
                    same_amount = False
                if not same_amount:
                    errors.append(
                        f"clean statement {index} {field} amount disagrees "
                        "with the manifest"
                    )
        clean_transactions = statement.get("transactions")
        if not isinstance(clean_transactions, list):
            errors.append(f"clean statement {index} transactions must be an array")
            continue
        statement_transaction_ids = [
            str(transaction.get("transaction_id"))
            for transaction in clean_transactions
            if isinstance(transaction, dict)
        ]
        clean_transaction_ids.extend(statement_transaction_ids)
        section_transaction_ids = sorted(
            str(transaction.get("transaction_id"))
            for transaction in transactions
            if isinstance(transaction, dict)
            and transaction.get("account_section_id") == section_id
        )
        if sorted(statement_transaction_ids) != section_transaction_ids:
            errors.append(
                f"clean statement {index} transactions are in the wrong section"
            )
    if sorted(clean_transaction_ids) != sorted(ids):
        errors.append("clean statement transactions do not match bundle transactions")
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
