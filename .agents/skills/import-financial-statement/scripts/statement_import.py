#!/usr/bin/env python3
"""Lossless financial-statement extractor for the Our Finances import contract."""

from __future__ import annotations

import argparse
import calendar
import csv
import hashlib
import io
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = "1.1.0"
PARSER_VERSION = "1.6.0"
MONEY_RE = re.compile(
    r"(?<![\w])(?:"
    r"[+-]?\s*[$€£]\s*\(?\d[\d.,]*\)?"
    r"|[+-]\s*\(?\d[\d.,]*\)?"
    r"|(?:USD|MXN|EUR|SGD|THB|JPY|VND|MYR|CAD|GBP|GPB)\s+\(?\d[\d.,]*\)?"
    r"|\(?\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\)?"
    r")(?![\w])",
    re.IGNORECASE,
)
ISO_DATE_RE = re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b")
US_DATE_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(20\d{2})\b")
MONTHS_EN = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
MONTHS_ES = {
    "ene": 1,
    "feb": 2,
    "mar": 3,
    "abr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "ago": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dic": 12,
    "enero": 1,
    "febrero": 2,
    "marzo": 3,
    "abril": 4,
    "mayo": 5,
    "junio": 6,
    "julio": 7,
    "agosto": 8,
    "septiembre": 9,
    "octubre": 10,
    "noviembre": 11,
    "diciembre": 12,
}
CSV_FIELDS = [
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
    "review_status",
    "fee",
    "balance",
    "quantity",
    "unit_price",
    "symbol",
    "external_id",
    "source_page",
    "source_page_end",
    "source_line_start",
    "source_line_end",
    "raw_text",
    "notes",
]


@dataclass
class SourcePage:
    page: int
    text: str
    lines: list[str]
    extraction_mode: str


@dataclass
class Section:
    account_section_id: str
    account_name: str
    account_last4: str | None
    account_type: str
    currency: str
    period_start: str | None
    period_end: str | None
    opening_balance: str | None = None
    closing_balance: str | None = None
    reconciliation_kind: str = "cash"
    positions: list[dict[str, Any]] = field(default_factory=list)


def sha256_bytes(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def short_id(prefix: str, *parts: Any) -> str:
    payload = "\x1f".join("" if value is None else str(value) for value in parts)
    return f"{prefix}_{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:24]}"


def decimal_text(value: Decimal | str | int | None) -> str | None:
    if value is None:
        return None
    dec = value if isinstance(value, Decimal) else Decimal(str(value))
    result = format(dec, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return "0" if result in {"-0", ""} else result


def parse_decimal(text: str | None) -> Decimal | None:
    if text is None:
        return None
    raw = text.strip()
    if not raw:
        return None
    negative_parentheses = "(" in raw and ")" in raw
    raw = re.sub(r"(?i)(USD|MXN|EUR|SGD|THB|JPY|VND|MYR|CAD|GBP|GPB)", "", raw)
    raw = raw.replace("$", "").replace("€", "").replace("£", "")
    raw = raw.replace(" ", "").replace("+", "").replace("(", "").replace(")", "")
    if not re.search(r"\d", raw):
        return None
    comma = raw.rfind(",")
    dot = raw.rfind(".")
    if comma >= 0 and dot >= 0:
        if comma > dot:
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif comma >= 0:
        suffix = len(raw) - comma - 1
        raw = raw.replace(",", ".") if suffix in {1, 2, 3, 4, 6, 8} else raw.replace(",", "")
    try:
        value = Decimal(raw)
    except InvalidOperation:
        return None
    return -abs(value) if negative_parentheses else value


def iso(d: date | None) -> str | None:
    return d.isoformat() if d else None


def parse_us_date(text: str) -> date | None:
    match = US_DATE_RE.search(text)
    if match:
        try:
            return date(
                int(match.group(3)),
                int(match.group(1)),
                int(match.group(2)),
            )
        except ValueError:
            return None
    match = re.search(r"\b([A-Za-z]{3})\s+(\d{1,2})(?:,\s*|\s+)(20\d{2})\b", text)
    if match and match.group(1).lower() in MONTHS_EN:
        try:
            return date(
                int(match.group(3)),
                MONTHS_EN[match.group(1).lower()],
                int(match.group(2)),
            )
        except ValueError:
            return None
    return None


def parse_short_month_date(text: str, year: int) -> date | None:
    match = re.search(r"\b([A-Za-z]{3})\s+(\d{1,2})\b", text)
    if match and match.group(1).lower() in MONTHS_EN:
        try:
            return date(
                year,
                MONTHS_EN[match.group(1).lower()],
                int(match.group(2)),
            )
        except ValueError:
            return None
    return None


def parse_spanish_date(text: str) -> date | None:
    match = re.search(
        r"\b(\d{1,2})\s+de\s+([A-Za-záéíóúñ]+)\s+de\s+(20\d{2})\b",
        text,
        re.IGNORECASE,
    )
    if not match:
        match = re.search(r"\b(\d{1,2})\s+([A-Za-z]{3})\s+(20\d{2})\b", text, re.IGNORECASE)
    if match:
        month = MONTHS_ES.get(match.group(2).lower())
        if month:
            try:
                return date(int(match.group(3)), month, int(match.group(1)))
            except ValueError:
                return None
    return None


def parse_english_date(text: str) -> date | None:
    match = re.search(
        r"\b(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})\b",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None
    month = MONTHS_EN.get(match.group(2)[:3].lower())
    if not month:
        return None
    try:
        return date(int(match.group(3)), month, int(match.group(1)))
    except ValueError:
        return None


def extract_pdf_pages(path: Path) -> list[SourcePage]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise SystemExit("pypdf is required to read PDF statements") from exc
    reader = PdfReader(str(path))
    pages: list[SourcePage] = []
    for index, page in enumerate(reader.pages, 1):
        mode = "pypdf-layout"
        try:
            text = page.extract_text(extraction_mode="layout") or ""
        except TypeError:
            mode = "pypdf"
            text = page.extract_text() or ""
        pages.append(SourcePage(index, text, text.splitlines(), mode))
    return pages


def detect_institution(text: str) -> str:
    lowered = text.lower()
    compacted = re.sub(r"\s+", " ", lowered)
    if "apple card" in lowered and "goldman sachs" in lowered:
        return "Apple Card"
    if (
        "savings customer:" in lowered
        and "goldman sachs bank usa" in lowered
        and "account summary" in lowered
    ):
        return "Apple Savings"
    if "cuenta nu" in lowered or "tarjeta de crédito nu" in lowered:
        return "Nu"
    if "micuenta" in lowered and (
        "banamex" in lowered or "detalle de operaciones" in lowered
    ):
        return "Banamex"
    if (
        "libretón básico cuenta digital" in lowered
        and "información financiera" in lowered
    ):
        return "BBVA"
    if re.search(r"\bwise\b", lowered) and (
        re.search(r"extracto(?:\s+'[^']+')?\s+en", lowered)
        or "wise payments" in lowered
    ):
        return "Wise"
    if "cash app investing llc" in lowered and "valuation summary" in lowered:
        return "Cash App Investing"
    if "cash app" in lowered and "savings statement" in lowered:
        return "Cash App Savings"
    if "cash app" in lowered and "account statement" in lowered:
        return "Cash App"
    if "capital one 360" in lowered or "capitalone.com" in lowered:
        return "Capital One"
    if (
        "paypal account id" in lowered
        and "account statements" in lowered
        and "account activity" in lowered
    ):
        return "PayPal"
    if (
        ("robinhood" in lowered or "rhs account number" in compacted)
        and "crypto statement" in compacted
        and "period start" in compacted
    ):
        return "Robinhood Crypto"
    if "robinhood securities" in lowered:
        return "Robinhood"
    return "Unknown"


def category_for(description: str, transaction_type: str) -> tuple[str, str, str]:
    text = description.upper()
    if transaction_type in {"transfer", "reversal"} or re.search(
        r"\b(TRANSFER|TRANSFERENCIA|TO SAVINGS|FROM SAVINGS|CAJITA)\b", text
    ):
        return "Transfers", "0.99", "rule"
    if transaction_type == "payment" or re.search(
        r"(CARD PAYMENT|APPLECARD|PAGO A TU TARJETA|PAYMENT)", text
    ):
        return "Credit card payments", "0.98", "rule"
    if transaction_type in {"buy", "sell", "trade"}:
        return "Investment buy/sell", "0.99", "rule"
    if transaction_type == "fee" or re.search(r"\b(FEE|COMISI[ÓO]N|TAX|ISR)\b", text):
        return "Fees & taxes", "0.95", "rule"
    if transaction_type in {"interest", "cashback", "dividend"} or re.search(
        r"(INTEREST|INTERESES|DINERO GENERADO|DAILY CASH|DIVIDEND)", text
    ):
        return "Interest / cashback / dividends", "0.97", "rule"
    if re.search(r"\b(UBER|LYFT|METROBUS|ECObici|SUBWAY)\b", text):
        return "Transportation", "0.88", "rule"
    if re.search(r"(LA COMER|OXXO|GROCERY|SUPERMARKET|MINISUPER)", text):
        return "Groceries", "0.86", "rule"
    if re.search(r"(RESTAUR|CAFE|COFFEE|BAKERY|PANADERIA|THAI|TOMMY BEANS)", text):
        return "Restaurants", "0.84", "rule"
    if re.search(r"(THERAP|TERAP)", text):
        return "Therapy", "0.94", "rule"
    if re.search(r"(LAUNDRY|LAVANDER)", text):
        return "Laundry", "0.93", "rule"
    if re.search(r"(DOCTOR|DR |FARMAC|PHARM|MEDIC)", text):
        return "Doctors", "0.85", "rule"
    if re.search(r"(NYTIMES|NEW YORK TIMES|NEWS)", text):
        return "News", "0.9", "rule"
    if re.search(r"(APPLE.COM/BILL|CHATGPT|BEEPER|NEBULA|YOUTUBE|SOFTWARE)", text):
        return "Productivity software", "0.78", "rule"
    if re.search(r"(SALARY|PAYROLL|N[ÓO]MINA)", text):
        return "Salary", "0.93", "rule"
    if re.search(r"(ATM|CAJERO|CASH WITHDRAWAL)", text):
        return "Cash withdrawals", "0.93", "rule"
    return "Needs review", "0.25", "needs_review"


def make_transaction(
    *,
    statement_id: str,
    section: Section,
    institution: str,
    sequence: int,
    transaction_date: str | None,
    description: str,
    amount: Decimal,
    source_page: int,
    source_line_start: int,
    source_line_end: int,
    source_page_end: int | None = None,
    raw_text: str,
    transaction_type: str = "unknown",
    posted_date: str | None = None,
    fee: Decimal | None = None,
    balance: Decimal | None = None,
    quantity: Decimal | None = None,
    unit_price: Decimal | None = None,
    symbol: str | None = None,
    external_id: str | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    category, confidence, source = category_for(description, transaction_type)
    amount_string = decimal_text(amount)
    tx_id = short_id(
        "txn",
        statement_id,
        section.account_section_id,
        transaction_date,
        description,
        amount_string,
        source_page,
        source_line_start,
        sequence,
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "transaction_id": tx_id,
        "statement_id": statement_id,
        "account_section_id": section.account_section_id,
        "account_name": section.account_name,
        "institution": institution,
        "account_type": section.account_type,
        "account_last4": section.account_last4,
        "period_start": section.period_start,
        "period_end": section.period_end,
        "transaction_date": transaction_date,
        "posted_date": posted_date,
        "description": re.sub(r"\s+", " ", description).strip(),
        "amount": amount_string,
        "currency": section.currency,
        "direction": "in" if amount > 0 else "out" if amount < 0 else "neutral",
        "transaction_type": transaction_type,
        "category": category,
        "category_confidence": confidence,
        "categorization_source": source,
        "review_status": "needs_review",
        "fee": decimal_text(fee),
        "balance": decimal_text(balance),
        "quantity": decimal_text(quantity),
        "unit_price": decimal_text(unit_price),
        "symbol": symbol,
        "external_id": external_id,
        "source_page": source_page,
        "source_page_end": source_page_end or source_page,
        "source_line_start": source_line_start,
        "source_line_end": source_line_end,
        "raw_text": raw_text,
        "notes": notes,
    }


def find_period(text: str) -> tuple[str | None, str | None]:
    dates = [parse_us_date(match.group(0)) for match in US_DATE_RE.finditer(text)]
    dates = [value for value in dates if value]
    if len(dates) >= 2:
        return iso(min(dates)), iso(max(dates))
    spanish = [parse_spanish_date(line) for line in text.splitlines()]
    spanish = [value for value in spanish if value]
    if len(spanish) >= 2:
        return iso(min(spanish)), iso(max(spanish))
    english = [parse_english_date(line) for line in text.splitlines()]
    english = [value for value in english if value]
    if len(english) >= 2:
        return iso(min(english)), iso(max(english))
    return None, None


def parse_apple(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    period_match = re.search(
        r"([A-Za-z]{3}\s+\d{1,2})\s*[—-]\s*([A-Za-z]{3}\s+\d{1,2}),\s*(20\d{2})",
        text,
    )
    if period_match:
        start = datetime.strptime(
            f"{period_match.group(1)} {period_match.group(3)}", "%b %d %Y"
        ).date()
        end = datetime.strptime(
            f"{period_match.group(2)} {period_match.group(3)}", "%b %d %Y"
        ).date()
        period_start, period_end = iso(start), iso(end)
    else:
        period_start, period_end = find_period(text)
    opening_match = re.search(r"Previous Monthly Balance\s+\$?([\d,.]+)", text)
    closing_matches = re.findall(r"(?<!Previous )Total Balance\s+\$?([\d,.]+)", text)
    section = Section(
        short_id("acct", statement_id, "apple-card"),
        "Apple Card",
        None,
        "credit",
        "USD",
        period_start,
        period_end,
        decimal_text(parse_decimal(opening_match.group(1))) if opening_match else None,
        decimal_text(parse_decimal(closing_matches[-1])) if closing_matches else None,
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    sequence = 0
    for page in pages:
        section_type = ""
        index = 0
        while index < len(page.lines):
            stripped = page.lines[index].strip()
            if stripped in {
                "Payments",
                "Transactions",
                "Interest Charged",
                "Interest Charges",
                "Fees",
            }:
                section_type = stripped
                index += 1
                continue
            interest_match = re.match(
                r"^Interest charge\s+\$?([\d,.]+)\s*$",
                stripped,
                re.IGNORECASE,
            )
            if section_type in {"Interest Charged", "Interest Charges"} and interest_match:
                amount = parse_decimal(interest_match.group(1))
                if amount is not None:
                    sequence += 1
                    transactions.append(
                        make_transaction(
                            statement_id=statement_id,
                            section=section,
                            institution="Apple Card",
                            sequence=sequence,
                            transaction_date=period_end,
                            description="Interest charge",
                            amount=amount,
                            source_page=page.page,
                            source_line_start=index + 1,
                            source_line_end=index + 1,
                            raw_text=page.lines[index],
                            transaction_type="interest",
                            notes=(
                                "The source prints no separate transaction date; "
                                "the statement period end is used for budgeting."
                            ),
                        )
                    )
                    parsed.add((page.page, index + 1))
                index += 1
                continue
            if re.match(r"^\d{2}/\d{2}/20\d{2}\b", stripped):
                block_start = index
                block = [page.lines[index]]
                index += 1
                while index < len(page.lines):
                    nxt = page.lines[index].strip()
                    if re.match(r"^\d{2}/\d{2}/20\d{2}\b", nxt):
                        break
                    if nxt.startswith("Total ") or nxt in {
                        "Payments",
                        "Transactions",
                        "Interest Charges",
                        "Fees",
                    }:
                        break
                    if nxt:
                        block.append(page.lines[index])
                    index += 1
                first = re.split(r"\s{2,}", block[0].strip())
                if len(first) >= 3:
                    amount = parse_decimal(first[-1])
                    tx_date = parse_us_date(first[0])
                    if amount is not None and tx_date:
                        transaction_type = (
                            "payment"
                            if section_type == "Payments"
                            else "interest"
                            if section_type == "Interest Charges"
                            else "fee"
                            if section_type == "Fees"
                            else "purchase"
                        )
                        description = first[1]
                        sequence += 1
                        transactions.append(
                            make_transaction(
                                statement_id=statement_id,
                                section=section,
                                institution="Apple Card",
                                sequence=sequence,
                                transaction_date=iso(tx_date),
                                description=description,
                                amount=amount,
                                source_page=page.page,
                                source_line_start=block_start + 1,
                                source_line_end=block_start + len(block),
                                raw_text="\n".join(block),
                                transaction_type=transaction_type,
                            )
                        )
                        for offset, companion_line in enumerate(block[1:], 1):
                            adjustment_match = re.match(
                                r"^\s*Daily Cash Adjustment\s+-?\d+(?:\.\d+)?%\s+\$?([\d,.]+)\s*$",
                                companion_line,
                                re.IGNORECASE,
                            )
                            if not adjustment_match:
                                continue
                            adjustment_amount = parse_decimal(adjustment_match.group(1))
                            if adjustment_amount is None:
                                continue
                            sequence += 1
                            transactions.append(
                                make_transaction(
                                    statement_id=statement_id,
                                    section=section,
                                    institution="Apple Card",
                                    sequence=sequence,
                                    transaction_date=iso(tx_date),
                                    description="Daily Cash Adjustment",
                                    amount=adjustment_amount,
                                    source_page=page.page,
                                    source_line_start=block_start + offset + 1,
                                    source_line_end=block_start + offset + 1,
                                    raw_text=companion_line,
                                    transaction_type="cashback_reversal",
                                    notes=(
                                        "Balance-affecting companion entry printed "
                                        "under the return transaction."
                                    ),
                                )
                            )
                        parsed.update(
                            (page.page, line_number)
                            for line_number in range(
                                block_start + 1, block_start + len(block) + 1
                            )
                        )
                continue
            index += 1
    return [section], transactions, parsed, []


def nonempty_groups(page: SourcePage) -> Iterable[tuple[int, int, list[str]]]:
    start = None
    group: list[str] = []
    for index, line in enumerate(page.lines):
        if line.strip():
            if start is None:
                start = index
            group.append(line)
        elif group:
            yield start + 1, index, group
            start, group = None, []
    if group and start is not None:
        yield start + 1, len(page.lines), group


def parse_apple_savings(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    period_match = re.search(
        r"([A-Za-z]{3}\s+\d{1,2},\s+20\d{2})\s*-\s*"
        r"([A-Za-z]{3}\s+\d{1,2},\s+20\d{2})",
        text,
    )
    period_start = iso(parse_us_date(period_match.group(1))) if period_match else None
    period_end = iso(parse_us_date(period_match.group(2))) if period_match else None
    account_match = re.search(r"^\s*Account\s+(\d+)\s*$", text, re.MULTILINE)
    opening_match = re.search(
        r"Beginning Balance \(as of .+?\)\s+\$?([\d,.]+)",
        text,
    )
    closing_match = re.search(
        r"Ending Balance \(as of .+?\)\s+\$?([\d,.]+)",
        text,
    )
    last4 = account_match.group(1)[-4:] if account_match else None
    section = Section(
        short_id("acct", statement_id, "apple-savings", last4),
        "Apple Savings",
        last4,
        "savings",
        "USD",
        period_start,
        period_end,
        decimal_text(parse_decimal(opening_match.group(1))) if opening_match else None,
        decimal_text(parse_decimal(closing_match.group(1))) if closing_match else None,
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    sequence = 0
    for page in pages:
        if "Account Activity" not in page.text:
            continue
        for line_number, line in enumerate(page.lines, 1):
            stripped = line.strip()
            match = re.match(
                r"^(\d{2}/\d{2}/20\d{2})\s+(.+?)\s+"
                r"(-?\s*\$[\d,.]+)\s+\$[\d,.]+\s*$",
                stripped,
            )
            if not match:
                continue
            description = match.group(2).strip()
            if description == "Opening Balance":
                parsed.add((page.page, line_number))
                continue
            tx_date = parse_us_date(match.group(1))
            amount = parse_decimal(match.group(3))
            if not tx_date or amount is None:
                continue
            sequence += 1
            transactions.append(
                make_transaction(
                    statement_id=statement_id,
                    section=section,
                    institution="Apple Savings",
                    sequence=sequence,
                    transaction_date=iso(tx_date),
                    description=description,
                    amount=amount,
                    source_page=page.page,
                    source_line_start=line_number,
                    source_line_end=line_number,
                    raw_text=line,
                    transaction_type=(
                        "interest"
                        if "Interest Paid" in description
                        else "transfer"
                    ),
                )
            )
            parsed.add((page.page, line_number))
    return [section], transactions, parsed, []


def bank_transaction_type(description: str, amount: Decimal) -> str:
    lowered = description.lower()
    if re.search(r"\b(comisi[oó]n|iva comisi[oó]n|charges?)\b", lowered):
        return "fee"
    if re.search(r"\b(retiro|disposici[oó]n|cajero)\b", lowered):
        return "cash_withdrawal"
    if re.search(
        r"\b(spei|interbancario|pago recibido|dep[oó]sito|pago a terceros)\b",
        lowered,
    ):
        return "transfer"
    if amount > 0:
        return "deposit"
    return "purchase"


def parse_banamex_online_activity(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    last_movement_match = re.search(
        r"Fecha de [uú]ltimo movimiento\s+(\d{1,2}\s+[A-Za-z]+\s+20\d{2})",
        text,
        re.IGNORECASE,
    )
    closing_match = re.search(
        r"^\s*Saldo\s+\$\s*([\d,.]+).*Fecha de [uú]ltimo movimiento",
        text,
        re.IGNORECASE | re.MULTILINE,
    )
    closing = parse_decimal(closing_match.group(1)) if closing_match else None
    last_movement = (
        parse_spanish_date(last_movement_match.group(1))
        if last_movement_match
        else None
    )
    dated_groups: list[tuple[int, int, int, list[str]]] = []
    for page in pages:
        for start, end, group in nonempty_groups(page):
            if re.search(
                r"\b\d{1,2}\s+(?:ago|sep)\s+20\d{2}\b",
                "\n".join(group),
                re.IGNORECASE,
            ) and not any("Fecha de último movimiento" in line for line in group):
                dated_groups.append((page.page, start, end, group))
    transaction_dates = [
        parse_spanish_date("\n".join(group))
        for _, _, _, group in dated_groups
    ]
    transaction_dates = [value for value in transaction_dates if value]
    period_start = iso(min(transaction_dates)) if transaction_dates else None
    period_end = iso(last_movement or max(transaction_dates)) if transaction_dates else None
    account_match = re.search(r"MiCuenta Banamex \*\*(\d+)", text)
    account_last4 = account_match.group(1)[-4:] if account_match else None
    section = Section(
        short_id("acct", statement_id, "banamex-online", account_last4 or ""),
        "Banamex MiCuenta",
        account_last4,
        "checking",
        "MXN",
        period_start,
        period_end,
        None,
        decimal_text(closing),
    )
    header = next(
        (
            line
            for page in pages
            for line in page.lines
            if "Depósitos" in line and "Retiros" in line and "Saldo" in line
        ),
        "",
    )
    deposit_column = header.find("Depósitos")
    withdrawal_column = header.find("Retiros")
    balance_column = header.rfind("Saldo")
    amount_boundary = (deposit_column + withdrawal_column) / 2
    balance_boundary = (withdrawal_column + balance_column) / 2
    parsed: set[tuple[int, int]] = set()
    transactions: list[dict[str, Any]] = []
    sequence = 0

    pending_group: tuple[int, int, int, list[str]] | None = None
    for page in pages:
        for start, end, group in nonempty_groups(page):
            joined = "\n".join(group)
            if "P. AUT." in joined and MONEY_RE.search(joined):
                pending_group = (page.page, start, end, group)
                break
        if pending_group:
            break
    activity_groups = dated_groups
    if pending_group:
        activity_groups = [pending_group, *activity_groups]

    for page_number, start, end, group in activity_groups:
        joined = "\n".join(group)
        tx_date = parse_spanish_date(joined)
        is_pending = "P. AUT." in joined and tx_date is None
        if is_pending:
            tx_date = last_movement
        amount: Decimal | None = None
        balance: Decimal | None = None
        for line in group:
            matches = list(MONEY_RE.finditer(line))
            if len(matches) < 2:
                continue
            amount_match, balance_match = matches[0], matches[-1]
            amount_value = parse_decimal(amount_match.group(0))
            balance_value = parse_decimal(balance_match.group(0))
            amount_position = line.find(
                "$", amount_match.start(), amount_match.end()
            )
            balance_position = line.find(
                "$", balance_match.start(), balance_match.end()
            )
            if amount_position < 0:
                amount_position = amount_match.start()
            if balance_position < 0:
                balance_position = balance_match.start()
            column_shift = balance_position - balance_column
            shifted_boundary = amount_boundary + column_shift
            if amount_value is not None:
                amount = (
                    abs(amount_value)
                    if amount_position < shifted_boundary
                    else -abs(amount_value)
                )
            if balance_value is not None:
                balance = balance_value
        if not tx_date or amount is None:
            continue
        description_parts: list[str] = []
        for line in group:
            cutoff = next(
                (
                    match.start()
                    for match in MONEY_RE.finditer(line)
                    if (
                        (
                            line.find("$", match.start(), match.end())
                            if "$" in match.group(0)
                            else match.start()
                        )
                        >= deposit_column - 5
                    )
                ),
                len(line),
            )
            value = line[:cutoff]
            value = re.sub(
                r"^\s*\d{1,2}\s+[A-Za-z]+\s+20\d{2}\s*", "", value
            ).strip()
            if value:
                description_parts.append(value)
        description = " ".join(description_parts)
        external_match = re.search(
            r"\b(?:AUT|P\. AUT\.|Referencia numérica:)\s*([A-Z0-9]+)",
            joined,
            re.IGNORECASE,
        )
        sequence += 1
        transactions.append(
            make_transaction(
                statement_id=statement_id,
                section=section,
                institution="Banamex",
                sequence=sequence,
                transaction_date=iso(tx_date),
                description=description,
                amount=amount,
                balance=balance,
                source_page=page_number,
                source_line_start=start,
                source_line_end=end,
                raw_text=joined,
                transaction_type=(
                    "pending_authorization"
                    if is_pending
                    else bank_transaction_type(description, amount)
                ),
                external_id=external_match.group(1) if external_match else None,
                notes=(
                    "Explicit pending authorization; the source supplies no "
                    "transaction date, so the report's last-movement date is used."
                    if is_pending
                    else None
                ),
            )
        )
        parsed.update(
            (page_number, line_number) for line_number in range(start, end + 1)
        )

    dated_transactions = [
        item
        for item in transactions
        if item["transaction_type"] != "pending_authorization"
    ]
    chain_passes = all(item["balance"] is not None for item in dated_transactions)
    if chain_passes:
        for newer, older in zip(dated_transactions, dated_transactions[1:]):
            if Decimal(newer["balance"]) != (
                Decimal(older["balance"]) + Decimal(newer["amount"])
            ):
                chain_passes = False
                break
    if pending_group and dated_transactions and closing is not None:
        pending = transactions[0]
        chain_passes = chain_passes and closing == (
            Decimal(dated_transactions[0]["balance"]) + Decimal(pending["amount"])
        )
    warnings: list[str] = []
    if chain_passes:
        parsed.update(
            (page.page, line_number)
            for page in pages
            for line_number, line in enumerate(page.lines, 1)
            if MONEY_RE.search(line)
        )
    else:
        warnings.append("Banamex online activity balance chain did not pass")
    return [section], transactions, parsed, warnings


def parse_banamex(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    if "Detalle de la cuenta" in text and "Movimientos" in text:
        return parse_banamex_online_activity(pages, statement_id)
    compact = re.sub(r"\s+", " ", text)
    period_match = re.search(
        r"Per[ií]odo del (\d{1,2}) de ([A-Za-záéíóúñ]+)"
        r"(?: del (20\d{2}))? al (\d{1,2}) de ([A-Za-záéíóúñ]+)"
        r" del (20\d{2})",
        compact,
        re.IGNORECASE,
    )
    if not period_match:
        return parse_generic(pages, statement_id)
    start_year = int(period_match.group(3) or period_match.group(6))
    end_year = int(period_match.group(6))
    start_month = MONTHS_ES[period_match.group(2).lower()]
    end_month = MONTHS_ES[period_match.group(5).lower()]
    period_start_date = date(start_year, start_month, int(period_match.group(1)))
    period_end_date = date(end_year, end_month, int(period_match.group(4)))
    account_match = re.search(r"Número de cuenta de cheques\s+(\d+)", text)
    account_last4 = account_match.group(1)[-4:] if account_match else None

    def summary_value(label: str) -> Decimal | None:
        for line in text.splitlines():
            if re.search(label, line, re.IGNORECASE):
                values = [
                    parse_decimal(match.group(0))
                    for match in MONEY_RE.finditer(line)
                ]
                values = [value for value in values if value is not None]
                if values:
                    return values[0]
        return None

    opening = summary_value(r"\bSaldo anterior\b")
    closing = summary_value(r"\bSaldo al (?:Corte|corte)\b")
    section = Section(
        short_id("acct", statement_id, "banamex", account_last4 or ""),
        "Banamex MiCuenta",
        account_last4,
        "checking",
        "MXN",
        iso(period_start_date),
        iso(period_end_date),
        decimal_text(opening),
        decimal_text(closing),
    )
    headers: dict[int, tuple[int, int, int]] = {}
    for page in pages:
        for line in page.lines:
            if (
                "RETIROS" in line
                and ("DEPÓSITOS" in line or "DEPOSITOS" in line)
                and "SALDO" in line
            ):
                deposit = max(line.find("DEPÓSITOS"), line.find("DEPOSITOS"))
                headers[page.page] = (
                    line.find("RETIROS"),
                    deposit,
                    line.rfind("SALDO"),
                )
                break
    record_start = re.compile(
        r"^\s*(\d{1,2})\s+"
        r"(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\b",
        re.IGNORECASE,
    )
    month_numbers = {
        key.upper(): value
        for key, value in MONTHS_ES.items()
        if len(key) == 3
    }
    records: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    table_started = False
    table_ended = False
    for page in pages:
        for line_number, line in enumerate(page.lines, 1):
            if "Detalle de Operaciones" in line:
                table_started = True
            if table_started and re.search(
                r"Resumen Operaciones Tarjeta|Total de Movimientos",
                line,
                re.IGNORECASE,
            ):
                if current:
                    records.append(current)
                    current = None
                table_ended = True
            if not table_started or table_ended:
                continue
            match = record_start.match(line)
            if match:
                if current:
                    records.append(current)
                current = {
                    "day": int(match.group(1)),
                    "month": month_numbers[match.group(2).upper()],
                    "lines": [],
                }
            if current:
                current["lines"].append((page.page, line_number, line))
    if current:
        records.append(current)

    parsed: set[tuple[int, int]] = set()
    transactions: list[dict[str, Any]] = []
    sequence = 0
    for record in records:
        values: list[tuple[str, Decimal]] = []
        for page_number, _, line in record["lines"]:
            if page_number not in headers:
                continue
            withdrawal, deposit, balance_column = headers[page_number]
            amount_boundary = (withdrawal + deposit) / 2
            balance_boundary = (deposit + balance_column) / 2
            for match in re.finditer(
                r"(?<!\d)(\d{1,3}(?:,\d{3})*\.\d{2})(-?)",
                line,
            ):
                value = Decimal(match.group(1).replace(",", ""))
                if match.group(2):
                    value = -value
                if match.start() >= balance_boundary:
                    values.append(("balance", value))
                elif match.start() >= amount_boundary:
                    values.append(("deposit", value))
                elif match.start() >= withdrawal - 5:
                    values.append(("withdrawal", value))
        amounts = [item for item in values if item[0] != "balance"]
        balances = [value for kind, value in values if kind == "balance"]
        parsed.update(
            (page_number, line_number)
            for page_number, line_number, _ in record["lines"]
        )
        if len(amounts) != 1 or not balances:
            continue
        amount = (
            abs(amounts[0][1])
            if amounts[0][0] == "deposit"
            else -abs(amounts[0][1])
        )
        month = record["month"]
        year = (
            end_year
            if start_year != end_year and month <= end_month
            else start_year
        )
        tx_date = date(year, month, record["day"])
        raw = "\n".join(line for _, _, line in record["lines"])
        description_parts: list[str] = []
        for page_number, _, line in record["lines"]:
            cutoff = len(line)
            if page_number in headers:
                cutoff = max(0, headers[page_number][0] - 5)
            value = line[:cutoff]
            value = record_start.sub("", value).strip()
            if value and not re.search(
                r"(Página \d+|Detalle de Operaciones|FECHA\s+CONCEPTO|"
                r"LIZETH MARIANA BERMUDEZ|SUC\. 508)",
                value,
                re.IGNORECASE,
            ):
                description_parts.append(value)
        description = " ".join(description_parts)
        external_match = re.search(
            r"\b(?:RASTREO|AUT|REF\.)[:\s]*([A-Z0-9]+)",
            raw,
            re.IGNORECASE,
        )
        sequence += 1
        first_page, first_line, _ = record["lines"][0]
        last_page, last_line, _ = record["lines"][-1]
        transactions.append(
            make_transaction(
                statement_id=statement_id,
                section=section,
                institution="Banamex",
                sequence=sequence,
                transaction_date=iso(tx_date),
                description=description,
                amount=amount,
                balance=balances[-1],
                source_page=first_page,
                source_page_end=last_page,
                source_line_start=first_line,
                source_line_end=last_line,
                raw_text=raw,
                transaction_type=bank_transaction_type(description, amount),
                external_id=external_match.group(1) if external_match else None,
            )
        )

    deposits_match = re.search(
        r"\(\+\)\s+(\d+)\s+Depósitos\s+([\d,.]+)", text
    )
    withdrawals_match = re.search(
        r"\(-\)\s+(\d+)\s+Retiros/Otros cargos\s+([\d,.]+)", text
    )
    actual_deposits = [Decimal(item["amount"]) for item in transactions if Decimal(item["amount"]) > 0]
    actual_withdrawals = [-Decimal(item["amount"]) for item in transactions if Decimal(item["amount"]) < 0]
    controls_pass = bool(
        opening is not None
        and closing is not None
        and deposits_match
        and withdrawals_match
        and len(actual_deposits) == int(deposits_match.group(1))
        and sum(actual_deposits, Decimal("0"))
        == Decimal(deposits_match.group(2).replace(",", ""))
        and len(actual_withdrawals) == int(withdrawals_match.group(1))
        and sum(actual_withdrawals, Decimal("0"))
        == Decimal(withdrawals_match.group(2).replace(",", ""))
        and opening
        + sum((Decimal(item["amount"]) for item in transactions), Decimal("0"))
        == closing
    )
    warnings: list[str] = []
    if controls_pass:
        parsed.update(
            (page.page, line_number)
            for page in pages
            for line_number, line in enumerate(page.lines, 1)
            if MONEY_RE.search(line)
        )
    else:
        warnings.append("Banamex transaction-count or balance controls did not pass")
    return [section], transactions, parsed, warnings


def parse_bbva(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    period_match = re.search(
        r"Periodo\s+DEL\s+(\d{2})/(\d{2})/(20\d{2})\s+AL\s+"
        r"(\d{2})/(\d{2})/(20\d{2})",
        text,
        re.IGNORECASE,
    )
    if not period_match:
        return parse_generic(pages, statement_id)
    period_start_date = date(
        int(period_match.group(3)),
        int(period_match.group(2)),
        int(period_match.group(1)),
    )
    period_end_date = date(
        int(period_match.group(6)),
        int(period_match.group(5)),
        int(period_match.group(4)),
    )
    account_match = re.search(r"No\. de Cuenta\s+(\d+)", text)
    account_last4 = account_match.group(1)[-4:] if account_match else None

    def last_value_on_line(label: str) -> Decimal | None:
        for line in text.splitlines():
            if label in line:
                values = [
                    parse_decimal(match.group(0))
                    for match in MONEY_RE.finditer(line)
                ]
                values = [value for value in values if value is not None]
                if values:
                    return values[-1]
        return None

    opening = last_value_on_line("Saldo Anterior")
    closing = last_value_on_line("Saldo Final")
    section = Section(
        short_id("acct", statement_id, "bbva", account_last4 or ""),
        "BBVA Libretón Básico",
        account_last4,
        "checking",
        "MXN",
        iso(period_start_date),
        iso(period_end_date),
        decimal_text(opening),
        decimal_text(closing),
    )
    row_pattern = re.compile(
        r"^\s*(\d{1,2})/([A-Z]{3})\s+(\d{1,2})/([A-Z]{3})\b",
        re.IGNORECASE,
    )
    records: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for page in pages:
        for line_number, line in enumerate(page.lines, 1):
            match = row_pattern.match(line)
            if match:
                if current:
                    records.append(current)
                current = {
                    "operation_day": int(match.group(1)),
                    "operation_month": MONTHS_ES[match.group(2).lower()],
                    "posted_day": int(match.group(3)),
                    "posted_month": MONTHS_ES[match.group(4).lower()],
                    "lines": [],
                }
            if current:
                if "Total de Movimientos" in line:
                    records.append(current)
                    current = None
                    break
                current["lines"].append((page.page, line_number, line))
    if current:
        records.append(current)

    parsed: set[tuple[int, int]] = set()
    transactions: list[dict[str, Any]] = []
    for sequence, record in enumerate(records, 1):
        first_page, first_line, source_line = record["lines"][0]
        money = list(
            re.finditer(
                r"(?<!\d)(\d{1,3}(?:,\d{3})*\.\d{2})(-?)",
                source_line,
            )
        )
        if not money:
            continue
        amount_match = money[0]
        amount = Decimal(amount_match.group(1).replace(",", ""))
        amount = amount if amount_match.start() >= 122 else -amount
        balance = (
            Decimal(money[1].group(1).replace(",", ""))
            if len(money) >= 2
            else None
        )
        operation_year = (
            period_end_date.year
            if period_start_date.year != period_end_date.year
            and record["operation_month"] <= period_end_date.month
            else period_start_date.year
        )
        posted_year = (
            period_end_date.year
            if period_start_date.year != period_end_date.year
            and record["posted_month"] <= period_end_date.month
            else period_start_date.year
        )
        raw = "\n".join(line for _, _, line in record["lines"])
        description_parts: list[str] = []
        for _, _, line in record["lines"]:
            cutoff = next(
                (
                    match.start()
                    for match in re.finditer(
                        r"(?<!\d)\d{1,3}(?:,\d{3})*\.\d{2}", line
                    )
                    if match.start() >= 100
                ),
                len(line),
            )
            value = row_pattern.sub("", line[:cutoff]).strip()
            if value and not re.search(
                r"(PAGINA\s+\d+|No\. de Cuenta|No\. de Cliente)",
                value,
                re.IGNORECASE,
            ):
                description_parts.append(value)
        description = " ".join(description_parts)
        external_match = re.search(
            r"\bReferencia\s+([A-Z0-9*]+)", raw, re.IGNORECASE
        )
        last_page, last_line, _ = record["lines"][-1]
        transactions.append(
            make_transaction(
                statement_id=statement_id,
                section=section,
                institution="BBVA",
                sequence=sequence,
                transaction_date=iso(
                    date(
                        operation_year,
                        record["operation_month"],
                        record["operation_day"],
                    )
                ),
                posted_date=iso(
                    date(
                        posted_year,
                        record["posted_month"],
                        record["posted_day"],
                    )
                ),
                description=description,
                amount=amount,
                balance=balance,
                source_page=first_page,
                source_page_end=last_page,
                source_line_start=first_line,
                source_line_end=last_line,
                raw_text=raw,
                transaction_type=bank_transaction_type(description, amount),
                external_id=external_match.group(1) if external_match else None,
            )
        )
        parsed.update(
            (page_number, line_number)
            for page_number, line_number, _ in record["lines"]
        )

    deposits_match = re.search(
        r"Depósitos / Abonos \(\+\)\s+(\d+)\s+([\d,.]+)", text
    )
    withdrawals_match = re.search(
        r"Retiros / Cargos \(-\)\s+(\d+)\s+([\d,.]+)", text
    )
    actual_deposits = [Decimal(item["amount"]) for item in transactions if Decimal(item["amount"]) > 0]
    actual_withdrawals = [-Decimal(item["amount"]) for item in transactions if Decimal(item["amount"]) < 0]
    controls_pass = bool(
        opening is not None
        and closing is not None
        and deposits_match
        and withdrawals_match
        and len(actual_deposits) == int(deposits_match.group(1))
        and sum(actual_deposits, Decimal("0"))
        == Decimal(deposits_match.group(2).replace(",", ""))
        and len(actual_withdrawals) == int(withdrawals_match.group(1))
        and sum(actual_withdrawals, Decimal("0"))
        == Decimal(withdrawals_match.group(2).replace(",", ""))
        and opening
        + sum((Decimal(item["amount"]) for item in transactions), Decimal("0"))
        == closing
    )
    warnings: list[str] = []
    if controls_pass:
        parsed.update(
            (page.page, line_number)
            for page in pages
            for line_number, line in enumerate(page.lines, 1)
            if MONEY_RE.search(line)
        )
    else:
        warnings.append("BBVA transaction-count or balance controls did not pass")
    return [section], transactions, parsed, warnings


def parse_wise(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    statement_match = re.search(
        r"(?:Extracto(?:\s+'([^']+)')?\s+en\s+([A-Z]{3})"
        r"|([A-Z]{3})\s+statement)",
        text,
        re.IGNORECASE,
    )
    savings_name = statement_match.group(1) if statement_match else None
    currency = (
        (statement_match.group(2) or statement_match.group(3)).upper()
        if statement_match
        else "USD"
    )
    period_match = re.search(
        r"(\d{1,2}\s+de\s+[A-Za-záéíóúñ]+\s+de\s+20\d{2})"
        r"[^\n]*?-\s*"
        r"(\d{1,2}\s+de\s+[A-Za-záéíóúñ]+\s+de\s+20\d{2})",
        text,
        re.IGNORECASE,
    )
    if period_match:
        period_start = iso(parse_spanish_date(period_match.group(1)))
        period_end = iso(parse_spanish_date(period_match.group(2)))
    else:
        english_period_match = re.search(
            r"(\d{1,2}\s+[A-Za-z]+\s+20\d{2})"
            r"[^\n]*?-\s*"
            r"(\d{1,2}\s+[A-Za-z]+\s+20\d{2})",
            text,
            re.IGNORECASE,
        )
        if english_period_match:
            period_start = iso(parse_english_date(english_period_match.group(1)))
            period_end = iso(parse_english_date(english_period_match.group(2)))
        else:
            period_start, period_end = find_period(text)
    closing_match: re.Match[str] | None = None
    closing_locator: tuple[int, int] | None = None
    for page in pages:
        for line_number, line in enumerate(page.lines, 1):
            if not re.search(
                rf"\b{re.escape(currency)}\b.*\b{re.escape(currency)}\s*$",
                line,
                re.IGNORECASE,
            ):
                continue
            values = [
                match.group(0)
                for match in MONEY_RE.finditer(line)
                if parse_decimal(match.group(0)) is not None
            ]
            if values and re.search(
                r"\b(?:Balance|el|en)\b.*20\d{2}", line, re.IGNORECASE
            ):
                closing_match = re.search(
                    r"([+-]?\s*[\d.,]+)\s+[A-Z]{3}\s*$", line
                )
                closing_locator = (page.page, line_number)
                break
        if closing_match:
            break
    account_match = re.search(r"Número de cuenta\s+Número de ruta\s*\n.*?\n.*?(\d{6,})", text)
    account_number = account_match.group(1) if account_match else ""
    section = Section(
        short_id("acct", statement_id, "wise", currency, account_number[-4:]),
        f"Wise {savings_name or currency}",
        account_number[-4:] or None,
        "savings" if savings_name else "checking",
        currency,
        period_start,
        period_end,
        None,
        decimal_text(parse_decimal(closing_match.group(1))) if closing_match else None,
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    if closing_locator:
        parsed.add(closing_locator)
    sequence = 0
    for page in pages:
        activity_header = next(
            (
                line
                for line in page.lines
                if ("Descripción" in line or "Description" in line)
                and (
                    "Entrante" in line
                    or "Saliente" in line
                    or "Incoming" in line
                    or "Outgoing" in line
                )
            ),
            "",
        )
        description_end = min(
            (
                position
                for position in (
                    activity_header.find("Entrante"),
                    activity_header.find("Saliente"),
                    activity_header.find("Incoming"),
                    activity_header.find("Outgoing"),
                )
                if position >= 0
            ),
            default=0,
        )
        for start, end, group in nonempty_groups(page):
            joined = "\n".join(group)
            if not re.search(
                r"(?:Transacci[oó]n|Transaction):\s*", joined, re.IGNORECASE
            ):
                continue
            transaction_line = next(
                (
                    line
                    for line in group
                    if re.search(
                        r"(?:Transacci[oó]n|Transaction):\s*",
                        line,
                        re.IGNORECASE,
                    )
                ),
                "",
            )
            tx_date = parse_spanish_date(transaction_line) or parse_english_date(
                transaction_line
            )
            if not tx_date:
                continue
            first = next(
                (
                    line
                    for line in group
                    if line != transaction_line
                    and len(
                        [
                            value
                            for value in (
                                parse_decimal(match.group(0))
                                for match in MONEY_RE.finditer(line)
                            )
                            if value is not None
                        ]
                    )
                    >= 2
                ),
                "",
            )
            if not first:
                continue
            values = [parse_decimal(match.group(0)) for match in MONEY_RE.finditer(first)]
            values = [value for value in values if value is not None]
            if len(values) < 2:
                continue
            amount, balance = values[-2], values[-1]
            description_lines = []
            for line in group:
                if line == transaction_line:
                    break
                without_columns = (
                    line[:description_end].strip()
                    if description_end
                    else re.split(r"\s{2,}", line.strip())[0].strip()
                )
                if without_columns:
                    description_lines.append(without_columns)
            description = " ".join(description_lines)
            external_match = re.search(
                r"(?:Transacci[oó]n|Transaction):\s*([^\s|]+)",
                joined,
                re.IGNORECASE,
            )
            lowered_description = description.lower()
            tx_type = (
                "interest"
                if "intereses" in lowered_description
                else "fee"
                if re.search(r"\b(charges?|comisi[oó]n|fee)\b", lowered_description)
                else "transfer"
            )
            if "tarjeta" in lowered_description:
                tx_type = "purchase"
            sequence += 1
            transactions.append(
                make_transaction(
                    statement_id=statement_id,
                    section=section,
                    institution="Wise",
                    sequence=sequence,
                    transaction_date=iso(tx_date),
                    description=description,
                    amount=amount,
                    balance=balance,
                    source_page=page.page,
                    source_line_start=start,
                    source_line_end=end,
                    raw_text=joined,
                    transaction_type=tx_type,
                    external_id=external_match.group(1) if external_match else None,
                )
            )
            parsed.update(
                (page.page, line_number) for line_number in range(start, end + 1)
            )
    return [section], transactions, parsed, []


def parse_nu(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    compact_text = re.sub(r"\s+", " ", text)
    is_credit = bool(
        re.search(
            r"(USO DE TU TARJETA DE CR[ÉE]DITO|RESUMEN DE TRANSACCIONES|"
            r"CARGOS, ABONOS Y COMPRAS REGULARES|Producto:\s*Tarjeta de Cr[ée]dito)",
            text,
            re.IGNORECASE,
        )
    )
    is_new_credit = "CARGOS, ABONOS Y COMPRAS REGULARES" in text

    def spanish_month(value: str) -> int | None:
        return MONTHS_ES.get(value.lower())

    credit_period = re.search(
        r"Periodo:\s*(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3})\s+(20\d{2})\s*"
        r"(?:-|al|a)\s*(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3})"
        r"(?:\s+(20\d{2}))?",
        compact_text,
        re.IGNORECASE,
    )
    debit_period = re.search(
        r"Periodo:\s*del\s*(\d{1,2})\s+al\s+(\d{1,2})\s+"
        r"([A-Za-zÁÉÍÓÚáéíóú]{3})\s+(20\d{2})",
        compact_text,
        re.IGNORECASE,
    )
    if credit_period:
        start_month = spanish_month(credit_period.group(2))
        end_month = spanish_month(credit_period.group(5))
        period_start = (
            iso(
                date(
                    int(credit_period.group(3)),
                    start_month,
                    int(credit_period.group(1)),
                )
            )
            if start_month
            else None
        )
        period_end = (
            iso(
                date(
                    int(credit_period.group(6) or credit_period.group(3)),
                    end_month,
                    int(credit_period.group(4)),
                )
            )
            if end_month
            else None
        )
    elif debit_period:
        month = spanish_month(debit_period.group(3))
        period_start = (
            iso(
                date(
                    int(debit_period.group(4)),
                    month,
                    int(debit_period.group(1)),
                )
            )
            if month
            else None
        )
        period_end = (
            iso(
                date(
                    int(debit_period.group(4)),
                    month,
                    int(debit_period.group(2)),
                )
            )
            if month
            else None
        )
    else:
        period_start, period_end = find_period(text)
    account_match = re.search(r"Cuenta Nu:\s*(\d+)", text)
    card_match = re.search(
        r"(?:TARJETA:|N[uú]mero de tarjeta:)\s*"
        r"(?:\d{4}|X{4})[^\n]*?(\d{4})\s*$",
        text,
        re.IGNORECASE | re.MULTILINE,
    )
    if is_credit and is_new_credit:
        opening_match = re.search(
            r"Adeudo del periodo anterior\s*=?\s*\$([\d,.]+)",
            text,
            re.IGNORECASE,
        )
        closing_match = re.search(
            r"PAGO PARA NO GENERAR INTERESES\s*=?\s*\$([\d,.]+)",
            text,
            re.IGNORECASE,
        )
    elif is_credit:
        opening_match = re.search(
            r"Saldo inicial del periodo[^\n]*?\$([\d,.]+)",
            text,
            re.IGNORECASE,
        )
        closing_match = re.search(
            r"Saldo actual al corte[^\n]*?\$([\d,.]+)",
            text,
            re.IGNORECASE,
        )
        if not closing_match:
            closing_match = re.search(
                r"Saldo total del periodo[^\n]*?\$([\d,.]+)",
                text,
                re.IGNORECASE,
            )
    else:
        opening_match = re.search(r"Saldo inicial\s+\$?([\d,.]+)", text)
        closing_match = re.search(
            r"Saldo al generar este estado de cuenta\s+\$?([\d,.]+)", text
        )
    account_last4 = (
        card_match.group(1)
        if is_credit and card_match
        else account_match.group(1)[-4:]
        if account_match
        else None
    )
    section = Section(
        short_id(
            "acct",
            statement_id,
            "nu-credit" if is_credit else "nu-account",
            account_last4 or "",
        ),
        "Nu credit card" if is_credit else "Nu account total",
        account_last4,
        "credit" if is_credit else "checking",
        "MXN",
        period_start,
        period_end,
        decimal_text(parse_decimal(opening_match.group(1))) if opening_match else None,
        decimal_text(parse_decimal(closing_match.group(1))) if closing_match else None,
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    sequence = 0

    def partial_credit_date(day: str, month_name: str) -> date | None:
        month = spanish_month(month_name)
        if not month or not period_start or not period_end:
            return None
        start = date.fromisoformat(period_start)
        end = date.fromisoformat(period_end)
        candidates: list[date] = []
        for year in {start.year, end.year}:
            try:
                candidate = date(year, month, int(day))
            except ValueError:
                continue
            if start <= candidate <= end:
                return candidate
            candidates.append(candidate)
        if not candidates:
            return None
        closest = min(
            candidates,
            key=lambda candidate: min(
                abs((candidate - start).days), abs((candidate - end).days)
            ),
        )
        return closest if -3 <= (closest - end).days <= 3 else None

    if is_credit:
        page_numbers = [page.page for page in pages]
        first_transaction_page = next(
            (
                page.page
                for page in pages
                if "TRANSACCIONES" in page.text
                or "CARGOS, ABONOS Y COMPRAS REGULARES" in page.text
            ),
            None,
        )
        first_post_transaction_page = next(
            (
                page.page
                for page in pages
                if first_transaction_page
                and page.page > first_transaction_page
                and re.search(
                    r"(INFORMACI[ÓO]N DE COSTOS|NOTAS ACLARATORIAS)",
                    page.text,
                    re.IGNORECASE,
                )
            ),
            None,
        )
        transaction_pages = (
            set(page_numbers)
            if is_new_credit
            else {
                number
                for number in page_numbers
                if first_transaction_page
                and number >= first_transaction_page
                and (
                    first_post_transaction_page is None
                    or number < first_post_transaction_page
                )
            }
        )
        old_categories = (
            "Transporte|Supermercado|Restaurante|Otros|Electrónicos|Electronicos|"
            "Servicio|Ropa|Viajes|Ocio|Salud|Educación|Educacion"
        )
        for page_index, page in enumerate(pages):
            if page.page not in transaction_pages:
                continue
            starts: list[
                tuple[int, re.Match[str], date | None, date | None, str, Decimal, str | None]
            ] = []
            for index, line in enumerate(page.lines):
                stripped = line.strip()
                if is_new_credit:
                    match = re.match(
                        r"^(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3})\s+(20\d{2})\s+"
                        r"(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3})\s+(20\d{2})\s+"
                        r"(.*?)\s+([+-]?\s*\$[\d,.]+)\s*$",
                        stripped,
                        re.IGNORECASE,
                    )
                    if not match:
                        continue
                    operation_date = parse_spanish_date(
                        f"{match.group(1)} {match.group(2)} {match.group(3)}"
                    )
                    posted_date = parse_spanish_date(
                        f"{match.group(4)} {match.group(5)} {match.group(6)}"
                    )
                    body = match.group(7).strip()
                    amount = parse_decimal(match.group(8))
                    statement_category = None
                else:
                    match = re.match(
                        r"^(\d{1,2})\s*([A-Za-zÁÉÍÓÚáéíóú]{3})(.*?)"
                        r"([+-]?\s*\$[\d,.]+)\s*$",
                        stripped,
                        re.IGNORECASE,
                    )
                    if not match or "Saldo final del periodo" in stripped:
                        continue
                    operation_date = partial_credit_date(
                        match.group(1), match.group(2)
                    )
                    posted_date = None
                    body = match.group(3).strip()
                    amount = parse_decimal(match.group(4))
                    # Some Nu PDFs paint the cardholder header over the first
                    # transaction rows. Their extracted text consequently
                    # concatenates the header, statement category, and merchant
                    # without whitespace (for example
                    # ``...MORALESTransporteUber* Trip``). The category is a
                    # structural column, so it is the reliable boundary even
                    # when its word boundaries have been destroyed.
                    category_match = re.search(
                        rf"({old_categories})(.*)$", body, re.IGNORECASE
                    )
                    if category_match:
                        statement_category = category_match.group(1)
                        body = category_match.group(2).strip()
                    else:
                        parts = [
                            part.strip()
                            for part in re.split(r"\s{2,}", body)
                            if part.strip()
                        ]
                        statement_category = parts[-2] if len(parts) >= 2 else None
                        body = parts[-1] if parts else body
                if operation_date and amount is not None:
                    starts.append(
                        (
                            index,
                            match,
                            operation_date,
                            posted_date,
                            body,
                            amount,
                            statement_category,
                        )
                    )
            for position, item in enumerate(starts):
                (
                    start,
                    _match,
                    operation_date,
                    posted_date,
                    description,
                    amount,
                    statement_category,
                ) = item
                next_start = (
                    starts[position + 1][0]
                    if position + 1 < len(starts)
                    else len(page.lines)
                )
                block_lines: list[str] = []
                block_end = start
                for line_index in range(start, next_start):
                    value = page.lines[line_index]
                    if line_index > start and re.search(
                        r"(Saldo final del periodo|En Nu usamos como referencia|"
                        r"INFORMACI[ÓO]N DE COSTOS|Notas:|^\s*\d+\s+de\s+\d+\s*$)",
                        value,
                        re.IGNORECASE,
                    ):
                        break
                    if value.strip():
                        block_lines.append(value)
                        block_end = line_index
                source_page_end = page.page
                if (
                    position == len(starts) - 1
                    and page_index + 1 < len(pages)
                    and pages[page_index + 1].page in transaction_pages
                ):
                    next_page = pages[page_index + 1]
                    leading_end = next(
                        (
                            line_index
                            for line_index, value in enumerate(next_page.lines)
                            if re.match(
                                r"^\s*\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóú]{3}",
                                value,
                                re.IGNORECASE,
                            )
                        ),
                        len(next_page.lines),
                    )
                    leading_details = [
                        (line_number, value)
                        for line_number, value in enumerate(
                            next_page.lines[:leading_end], 1
                        )
                        if re.search(
                            r"(Cambio\s*\(|\b(?:USD|MXN|EUR|SGD|THB|JPY|"
                            r"VND|MYR|CAD|GBP|GPB)\s+[\d,.]+)",
                            value,
                            re.IGNORECASE,
                        )
                    ]
                    if leading_details:
                        block_lines.extend(value for _, value in leading_details)
                        source_page_end = next_page.page
                        parsed.update(
                            (next_page.page, line_number)
                            for line_number, _ in leading_details
                        )
                lowered = description.lower()
                transaction_type = (
                    "payment"
                    if amount < 0
                    and re.search(r"(pago|gracias|abono)", lowered, re.IGNORECASE)
                    else "reversal"
                    if amount < 0
                    else "interest"
                    if "interés" in lowered or "interes" in lowered
                    else "fee"
                    if re.search(r"(comisi[oó]n|iva)", lowered, re.IGNORECASE)
                    else "purchase"
                )
                sequence += 1
                transactions.append(
                    make_transaction(
                        statement_id=statement_id,
                        section=section,
                        institution="Nu",
                        sequence=sequence,
                        transaction_date=iso(operation_date),
                        posted_date=iso(posted_date),
                        description=description,
                        amount=amount,
                        source_page=page.page,
                        source_page_end=source_page_end,
                        source_line_start=start + 1,
                        source_line_end=block_end + 1,
                        raw_text="\n".join(block_lines),
                        transaction_type=transaction_type,
                        notes=(
                            f"Statement category: {statement_category}"
                            if statement_category
                            else None
                        ),
                    )
                )
                parsed.update(
                    (page.page, line_number)
                    for line_number in range(start + 1, block_end + 2)
                )
    else:
        row_pattern = re.compile(
            r"^\s*(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3})\s+(20\d{2})\s+"
            r"(.*?)\s+([+-]?\$[\d,.]+)\s*$",
            re.IGNORECASE,
        )
        split_row_pattern = re.compile(
            r"^\s*(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3})\s+"
            r"(.*?)\s+([+-]?\$[\d,.]+)\s*$",
            re.IGNORECASE,
        )
        for page_index, page in enumerate(pages):
            starts: list[tuple[int, date, str, Decimal, int]] = []
            for index, line in enumerate(page.lines):
                match = row_pattern.match(line)
                consumed_year_line = 0
                if match:
                    tx_date = parse_spanish_date(
                        f"{match.group(1)} {match.group(2)} {match.group(3)}"
                    )
                    description = match.group(4)
                    amount = parse_decimal(match.group(5))
                else:
                    split_match = split_row_pattern.match(line)
                    next_value = (
                        page.lines[index + 1].strip()
                        if index + 1 < len(page.lines)
                        else ""
                    )
                    if not split_match or not re.fullmatch(r"20\d{2}", next_value):
                        continue
                    tx_date = parse_spanish_date(
                        f"{split_match.group(1)} {split_match.group(2)} {next_value}"
                    )
                    description = split_match.group(3)
                    amount = parse_decimal(split_match.group(4))
                    consumed_year_line = 1
                if tx_date and amount is not None:
                    starts.append(
                        (index, tx_date, description.strip(), amount, consumed_year_line)
                    )
            for position, item in enumerate(starts):
                start, tx_date, description, amount, consumed_year_line = item
                next_start = (
                    starts[position + 1][0]
                    if position + 1 < len(starts)
                    else len(page.lines)
                )
                block_lines: list[str] = []
                block_end = start + consumed_year_line
                for line_index in range(start, next_start):
                    value = page.lines[line_index]
                    if line_index > start + consumed_year_line and re.search(
                        r"(Con estos movimientos|Nu M[ée]xico Financiera|"
                        r"DINERO GENERADO EN TU CUENTA|CONTACTO|"
                        r"COMPROBANTE FISCAL|^\s*\d+\s+de\s+\d+\s*$)",
                        value,
                        re.IGNORECASE,
                    ):
                        break
                    if value.strip():
                        block_lines.append(value)
                        block_end = line_index
                source_page_end = page.page
                if position == len(starts) - 1 and page_index + 1 < len(pages):
                    next_page = pages[page_index + 1]
                    next_page_starts = [
                        line_index
                        for line_index, value in enumerate(next_page.lines)
                        if row_pattern.match(value)
                        or (
                            split_row_pattern.match(value)
                            and line_index + 1 < len(next_page.lines)
                            and re.fullmatch(
                                r"20\d{2}", next_page.lines[line_index + 1].strip()
                            )
                        )
                    ]
                    leading_end = next_page_starts[0] if next_page_starts else 0
                    leading_details = [
                        value
                        for value in next_page.lines[:leading_end]
                        if re.search(
                            r"(Transferencia SPEI|Dep[oó]sito SPEI|cliente|"
                            r"instituci[oó]n|concepto|cuenta|clabe|"
                            r"Clave de rastreo|Clave de referencia)",
                            value,
                            re.IGNORECASE,
                        )
                        and not re.search(r"Cuenta Nu:", value, re.IGNORECASE)
                    ]
                    if leading_details:
                        block_lines.extend(leading_details)
                        source_page_end = next_page.page
                        for line_number, value in enumerate(
                            next_page.lines[:leading_end], 1
                        ):
                            if value in leading_details:
                                parsed.add((next_page.page, line_number))
                block_text = "\n".join(block_lines)
                lowered = f"{description}\n{block_text}".lower()
                transaction_type = (
                    "payment"
                    if "pago a tu tarjeta" in lowered
                    else "transfer"
                    if re.search(
                        r"(cajita|transferencia spei|dep[oó]sito spei)",
                        lowered,
                        re.IGNORECASE,
                    )
                    else "reversal"
                    if re.search(
                        r"(devoluci[oó]n|monto reembolsado)", lowered, re.IGNORECASE
                    )
                    else "purchase"
                    if "compra" in lowered
                    else "transfer"
                )
                external_match = re.search(
                    r"Clave de rastreo\s+([A-Za-z0-9]+)", block_text, re.IGNORECASE
                )
                sequence += 1
                transactions.append(
                    make_transaction(
                        statement_id=statement_id,
                        section=section,
                        institution="Nu",
                        sequence=sequence,
                        transaction_date=iso(tx_date),
                        description=description,
                        amount=amount,
                        source_page=page.page,
                        source_page_end=source_page_end,
                        source_line_start=start + 1,
                        source_line_end=block_end + 1,
                        raw_text=block_text,
                        transaction_type=transaction_type,
                        external_id=(
                            external_match.group(1) if external_match else None
                        ),
                        notes=(
                            "Nu Cajita subaccount movement"
                            if "cajita" in lowered
                            else None
                        ),
                    )
                )
                parsed.update(
                    (page.page, line_number)
                    for line_number in range(start + 1, block_end + 2)
                )

        interest_components = (
            (
                "Dinero generado antes de impuestos",
                "interest",
                re.compile(
                    r"Dinero generado antes de impuestos[^\n]*?\$([\d,.]+)",
                    re.IGNORECASE,
                ),
            ),
            (
                "Impuestos sobre el dinero generado",
                "fee",
                re.compile(
                    r"Impuestos sobre el dinero generado[^\n]*?(-?\$[\d,.]+)",
                    re.IGNORECASE,
                ),
            ),
        )
        for description, transaction_type, pattern in interest_components:
            for page in pages:
                for line_number, line in enumerate(page.lines, 1):
                    match = pattern.search(line)
                    if not match:
                        continue
                    amount = parse_decimal(match.group(1))
                    parsed.add((page.page, line_number))
                    if amount is None or amount == 0:
                        break
                    sequence += 1
                    transactions.append(
                        make_transaction(
                            statement_id=statement_id,
                            section=section,
                            institution="Nu",
                            sequence=sequence,
                            transaction_date=period_end,
                            description=description,
                            amount=amount,
                            source_page=page.page,
                            source_line_start=line_number,
                            source_line_end=line_number,
                            raw_text=line,
                            transaction_type=transaction_type,
                            notes="Statement-provided period-end interest component",
                        )
                    )
                    break
                else:
                    continue
                break
    return [section], transactions, parsed, []


def parse_cash_app(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    cover_text = pages[0].text if pages else ""
    is_savings = "Savings Statement" in cover_text
    institution = "Cash App Savings" if is_savings else "Cash App"
    account_name = "Cash App Savings" if is_savings else "Cash App account"
    account_type = "savings" if is_savings else "cash"
    period_match = re.search(r"\b([A-Za-z]+)\s+(20\d{2})\b", cover_text)
    if period_match:
        month = MONTHS_EN[period_match.group(1)[:3].lower()]
        year = int(period_match.group(2))
        balance_dates = [
            parse_short_month_date(match.group(1), year)
            for match in re.finditer(
                r"\bBalance on\s+([A-Za-z]{3}\s+\d{1,2})\b",
                cover_text,
                re.IGNORECASE,
            )
        ]
        balance_dates = [value for value in balance_dates if value]
        period_start = iso(balance_dates[0]) if balance_dates else iso(date(year, month, 1))
        period_end = iso(balance_dates[-1]) if len(balance_dates) > 1 else iso(
            date(year, month, calendar.monthrange(year, month)[1])
        )
    else:
        year, period_start, period_end = date.today().year, None, None
    opening_match = re.search(
        r"Balance on [A-Za-z]{3} \d+\s+\$?([\d,.]+)", cover_text
    )
    closing_matches = re.findall(
        r"Balance on [A-Za-z]{3} \d+\s+\$?([\d,.]+)", cover_text
    )
    summary_values: list[Decimal] = []
    summary_line: tuple[int, int] | None = None
    for page in pages:
        for index, line in enumerate(page.lines):
            if line.count("Balance on") >= 2:
                for following_index in range(index + 1, min(index + 5, len(page.lines))):
                    values = [
                        parse_decimal(match.group(0))
                        for match in MONEY_RE.finditer(page.lines[following_index])
                    ]
                    summary_values = [value for value in values if value is not None]
                    if len(summary_values) >= 3:
                        summary_line = (page.page, following_index + 1)
                        break
            if summary_values:
                break
        if summary_values:
            break
    section = Section(
        short_id("acct", statement_id, "cash-app-savings" if is_savings else "cash-app"),
        account_name,
        None,
        account_type,
        "USD",
        period_start,
        period_end,
        decimal_text(summary_values[0])
        if summary_values
        else decimal_text(parse_decimal(opening_match.group(1)))
        if opening_match
        else None,
        decimal_text(summary_values[-1])
        if summary_values
        else decimal_text(parse_decimal(closing_matches[-1]))
        if closing_matches
        else None,
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    if summary_line:
        parsed.add(summary_line)
    sequence = 0
    for page in pages:
        if "Transactions" not in page.text:
            continue
        for index, line in enumerate(page.lines, 1):
            stripped = line.strip()
            if not re.match(r"^[A-Za-z]{3}\s+\d{1,2}\b", stripped):
                continue
            parts = re.split(r"\s{2,}", stripped)
            if len(parts) < 4:
                continue
            tx_date = parse_short_month_date(parts[0], year)
            amount = parse_decimal(parts[-1])
            if not tx_date or amount is None:
                continue
            description = parts[1]
            details = parts[2]
            if not re.search(r"[+-]", parts[-1]):
                is_outflow = (
                    description.lower().startswith("to ")
                    or "cash app card" in details.lower()
                )
                amount = -abs(amount) if is_outflow else abs(amount)
            fee = parse_decimal(parts[-2])
            if (
                "transfer" in details.lower()
                or re.search(
                    r"\b(to|from)\s+(?:savings|cash app)\b",
                    description,
                    re.IGNORECASE,
                )
            ):
                transaction_type = "transfer"
            elif "dividend" in description.lower():
                transaction_type = "dividend"
            elif "interest" in description.lower():
                transaction_type = "interest"
            elif re.search(r"\b(sale|sell)\b", stripped, re.IGNORECASE):
                transaction_type = "sell"
            else:
                transaction_type = "purchase"
            sequence += 1
            transactions.append(
                make_transaction(
                    statement_id=statement_id,
                    section=section,
                    institution=institution,
                    sequence=sequence,
                    transaction_date=iso(tx_date),
                    description=description,
                    amount=amount,
                    fee=fee,
                    source_page=page.page,
                    source_line_start=index,
                    source_line_end=index,
                    raw_text=line,
                    transaction_type=transaction_type,
                )
            )
            parsed.add((page.page, index))
    return [section], transactions, parsed, []


def parse_cash_app_investing(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    period_match = re.search(
        r"\b([A-Za-z]+ \d{2}, 20\d{2})\s*-\s*"
        r"([A-Za-z]+ \d{2}, 20\d{2})\b",
        pages[0].text if pages else text,
    )
    if period_match:
        start = datetime.strptime(period_match.group(1), "%B %d, %Y").date()
        end = datetime.strptime(period_match.group(2), "%B %d, %Y").date()
        period_start, period_end = iso(start), iso(end)
    else:
        period_start, period_end = find_period(text)
    account_match = re.search(r"Account Number:\s*(\S+)", text)
    opening_match = re.search(
        r"Beginning Account Value\s+(\(?\$?[\d,.]+\)?)", text
    )
    closing_match = re.search(
        r"Ending Account Value\s+(\(?\$?[\d,.]+\)?)", text
    )
    section = Section(
        short_id(
            "acct",
            statement_id,
            "cash-app-investing",
            account_match.group(1)[-4:] if account_match else "",
        ),
        "Cash App Investing",
        account_match.group(1)[-4:] if account_match else None,
        "brokerage",
        "USD",
        period_start,
        period_end,
        decimal_text(parse_decimal(opening_match.group(1))) if opening_match else None,
        decimal_text(parse_decimal(closing_match.group(1))) if closing_match else None,
        reconciliation_kind="market_value",
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    sequence = 0
    type_map = {
        "BUY": "buy",
        "SELL": "sell",
        "DIV": "dividend",
        "CSD": "transfer",
        "INT": "interest",
        "FEE": "fee",
    }
    for page in pages:
        if "ACTIVITY" not in page.text:
            continue
        for line_number, line in enumerate(page.lines, 1):
            stripped = line.strip()
            if not US_DATE_RE.match(stripped):
                continue
            parts = re.split(r"\s{2,}", stripped)
            if len(parts) < 6 or not US_DATE_RE.fullmatch(parts[0]):
                continue
            trade_date = parse_us_date(parts[0])
            settle_date = parse_us_date(parts[1])
            activity_type = parts[3].upper()
            amount = parse_decimal(parts[-1])
            if not trade_date or amount is None:
                continue
            has_trade_fields = (
                len(parts) >= 8 and activity_type in {"BUY", "SELL", "DIV"}
            )
            description_end = -3 if has_trade_fields else -1
            description = " ".join(parts[4:description_end])
            quantity = parse_decimal(parts[-3]) if has_trade_fields else None
            unit_price = parse_decimal(parts[-2]) if has_trade_fields else None
            symbol_match = re.match(r"([A-Z][A-Z0-9.]*)\s+-", description)
            sequence += 1
            transactions.append(
                make_transaction(
                    statement_id=statement_id,
                    section=section,
                    institution="Cash App Investing",
                    sequence=sequence,
                    transaction_date=iso(trade_date),
                    posted_date=iso(settle_date),
                    description=description,
                    amount=amount,
                    quantity=quantity,
                    unit_price=unit_price,
                    symbol=symbol_match.group(1) if symbol_match else None,
                    source_page=page.page,
                    source_line_start=line_number,
                    source_line_end=line_number,
                    raw_text=line,
                    transaction_type=type_map.get(activity_type, activity_type.lower()),
                )
            )
            parsed.add((page.page, line_number))
    return [section], transactions, parsed, []


def parse_capital_one(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    period_match = re.search(
        r"STATEMENT PERIOD\s+([A-Za-z]{3}\s+\d{1,2})\s*-\s*([A-Za-z]{3}\s+\d{1,2}),\s*(20\d{2})",
        text,
    )
    if period_match:
        year = int(period_match.group(3))
        start = parse_short_month_date(period_match.group(1), year)
        end = parse_short_month_date(period_match.group(2), year)
        period_start, period_end = iso(start), iso(end)
    else:
        year = date.today().year
        period_start, period_end = find_period(text)
    sections: list[Section] = []
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    current: Section | None = None
    sequence = 0
    for page in pages:
        for index, line in enumerate(page.lines, 1):
            stripped = line.strip()
            account_match = re.match(r"^(360 .+?)\s+-\s+(\d{4,})$", stripped)
            if account_match:
                name = account_match.group(1)
                current = Section(
                    short_id("acct", statement_id, "capital-one", account_match.group(2)[-4:]),
                    name,
                    account_match.group(2)[-4:],
                    "savings" if "Savings" in name else "checking",
                    "USD",
                    period_start,
                    period_end,
                )
                sections.append(current)
                continue
            if current is None:
                continue
            parts = re.split(r"\s{2,}", stripped)
            if not parts or not re.match(r"^[A-Za-z]{3}\s+\d{1,2}$", parts[0]):
                continue
            tx_date = parse_short_month_date(parts[0], year)
            description = parts[1] if len(parts) > 1 else ""
            money = [parse_decimal(part) for part in parts[2:] if MONEY_RE.search(part)]
            money = [value for value in money if value is not None]
            if "Opening Balance" in description:
                current.opening_balance = decimal_text(money[-1]) if money else None
                parsed.add((page.page, index))
                continue
            if "Closing Balance" in description:
                current.closing_balance = decimal_text(money[-1]) if money else None
                parsed.add((page.page, index))
                continue
            if not tx_date:
                continue
            amount = money[-2] if len(money) >= 2 else Decimal("0")
            balance = money[-1] if money else None
            if amount == 0:
                # Capital One prints dated account notices such as interest-rate
                # changes in the activity table with only a running balance.
                # They are reviewed source lines, but they are not transactions.
                parsed.add((page.page, index))
                continue
            tx_type = (
                "interest"
                if "Interest Paid" in description
                else "payment"
                if "APPLECARD" in description
                else "transfer"
            )
            sequence += 1
            transactions.append(
                make_transaction(
                    statement_id=statement_id,
                    section=current,
                    institution="Capital One",
                    sequence=sequence,
                    transaction_date=iso(tx_date),
                    description=description,
                    amount=amount,
                    balance=balance,
                    source_page=page.page,
                    source_line_start=index,
                    source_line_end=index,
                    raw_text=line,
                    transaction_type=tx_type,
                )
            )
            parsed.add((page.page, index))
    return sections, transactions, parsed, []


def parse_paypal(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    def page_period(page: SourcePage) -> tuple[str | None, str | None]:
        for line_index, line in enumerate(page.lines):
            match = re.search(
                r"([A-Za-z]{3}\s+\d{1,2},\s+20\d{2})\s*-\s*"
                r"([A-Za-z]{3}\s+\d{1,2}),",
                line,
            )
            if not match:
                continue
            start = datetime.strptime(match.group(1), "%b %d, %Y").date()
            end_year_match = re.search(
                r"\b(20\d{2})\b",
                page.lines[line_index + 1] if line_index + 1 < len(page.lines) else "",
            )
            end_year = int(end_year_match.group(1)) if end_year_match else start.year
            end = datetime.strptime(
                f"{match.group(2)}, {end_year}", "%b %d, %Y"
            ).date()
            return iso(start), iso(end)
        return None, None

    def transaction_key(item: dict[str, Any]) -> tuple[str, ...]:
        external_id = str(item.get("external_id") or "").strip()
        if external_id:
            return ("id", external_id)
        return (
            "fields",
            str(item["transaction_date"]),
            re.sub(r"\s+", " ", str(item["description"])).strip().upper(),
            str(item["amount"]),
            str(item.get("fee") or "0"),
        )

    overall_start, overall_end = page_period(pages[0])
    account_section = Section(
        short_id("acct", statement_id, "paypal", "account"),
        "PayPal account",
        None,
        "payment",
        "USD",
        overall_start,
        overall_end,
    )
    balance_page = next(
        (
            page
            for page in pages
            if re.search(
                r"^\s*PAYPAL BALANCE ACCOUNT\s*$",
                page.text,
                re.MULTILINE | re.IGNORECASE,
            )
        ),
        None,
    )
    balance_section: Section | None = None
    if balance_page is not None:
        balance_start, balance_end = page_period(balance_page)
        opening_match = re.search(
            r"Available beginning\s+([+-]?[\d,.]+)", balance_page.text, re.IGNORECASE
        )
        closing_match = re.search(
            r"Available ending\s+([+-]?[\d,.]+)", balance_page.text, re.IGNORECASE
        )
        balance_section = Section(
            short_id("acct", statement_id, "paypal", "balance"),
            "PayPal Balance",
            None,
            "payment",
            "USD",
            balance_start or overall_start,
            balance_end or overall_end,
            decimal_text(parse_decimal(opening_match.group(1)))
            if opening_match
            else None,
            decimal_text(parse_decimal(closing_match.group(1)))
            if closing_match
            else None,
        )

    source_rows: dict[str, list[dict[str, Any]]] = {
        "account": [],
        "balance": [],
    }
    parsed: set[tuple[int, int]] = set()
    active_section = "account"
    for page in pages:
        if re.search(
            r"^\s*PAYPAL BALANCE ACCOUNT\s*$",
            page.text,
            re.MULTILINE | re.IGNORECASE,
        ):
            active_section = "balance"
        elif re.search(r"^\s*PAYPAL ACCOUNT\s*$", page.text, re.MULTILINE | re.IGNORECASE):
            active_section = "account"
        for start_line, end_line, group in nonempty_groups(page):
            first = group[0]
            match = re.match(
                r"^\s*(\d{2}/\d{2}/\d{4})\s{2,}(.+?)\s{2,}"
                r"([A-Z]{3})\s{2,}([+-]?[\d,.]+)\s{2,}"
                r"([+-]?[\d,.]+)\s{2,}([+-]?[\d,.]+)\s*$",
                first,
            )
            if not match:
                continue
            tx_date = parse_us_date(match.group(1))
            amount = parse_decimal(match.group(6))
            fee = parse_decimal(match.group(5))
            if tx_date is None or amount is None:
                continue
            detail_lines = [line.strip() for line in group[1:] if line.strip()]
            external_id_match = next(
                (
                    re.match(r"ID:\s*(\S+)", line, re.IGNORECASE)
                    for line in detail_lines
                    if re.match(r"ID:\s*(\S+)", line, re.IGNORECASE)
                ),
                None,
            )
            description_details = [
                line
                for line in detail_lines
                if not re.match(r"(?:Individual )?ID:", line, re.IGNORECASE)
            ]
            description = " ".join(
                [match.group(2).strip(), *description_details]
            ).strip()
            tx_type = (
                "payment"
                if "APPLECARD" in description.upper()
                else "transfer"
            )
            source_rows[active_section].append(
                {
                    "transaction_date": iso(tx_date),
                    "description": description,
                    "amount": decimal_text(amount),
                    "fee": decimal_text(fee),
                    "external_id": (
                        external_id_match.group(1) if external_id_match else None
                    ),
                    "source_page": page.page,
                    "source_line_start": start_line,
                    "source_line_end": end_line,
                    "raw_text": "\n".join(group),
                    "transaction_type": tx_type,
                }
            )
            parsed.update(
                (page.page, line_number)
                for line_number in range(start_line, end_line + 1)
            )

    balance_keys = {
        transaction_key(item) for item in source_rows["balance"]
    }
    account_only = [
        item
        for item in source_rows["account"]
        if transaction_key(item) not in balance_keys
    ]
    emitted_rows: list[tuple[Section, dict[str, Any]]] = [
        (account_section, item) for item in account_only
    ]
    if balance_section is not None:
        emitted_rows.extend(
            (balance_section, item) for item in source_rows["balance"]
        )
    else:
        emitted_rows.extend(
            (account_section, item) for item in source_rows["account"]
        )

    transactions: list[dict[str, Any]] = []
    for sequence, (section, item) in enumerate(emitted_rows, 1):
        transactions.append(
            make_transaction(
                statement_id=statement_id,
                section=section,
                institution="PayPal",
                sequence=sequence,
                transaction_date=item["transaction_date"],
                description=item["description"],
                amount=Decimal(item["amount"]),
                fee=(
                    Decimal(item["fee"])
                    if item.get("fee") is not None
                    else None
                ),
                external_id=item.get("external_id"),
                source_page=item["source_page"],
                source_line_start=item["source_line_start"],
                source_line_end=item["source_line_end"],
                raw_text=item["raw_text"],
                transaction_type=item["transaction_type"],
            )
        )

    sections = [account_section]
    if balance_section is not None:
        sections.append(balance_section)
    duplicate_count = len(source_rows["account"]) - len(account_only)
    warnings = (
        [
            "Matching PayPal Balance activity is repeated in the PayPal account "
            f"section; {duplicate_count} duplicate source row(s) were classified "
            "but emitted once"
        ]
        if duplicate_count
        else []
    )
    return sections, transactions, parsed, warnings


def parse_robinhood_crypto(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    period_start_match = re.search(
        r"PERIOD START\s+(20\d{2}-\d{2}-\d{2})", text, re.IGNORECASE
    )
    period_end_match = re.search(
        r"PERIOD END\s+(20\d{2}-\d{2}-\d{2})", text, re.IGNORECASE
    )
    opening_match = re.search(
        r"OPENING BALANCE\s+\$?([+-]?[\d,.]+)", text, re.IGNORECASE
    )
    closing_match = re.search(
        r"CLOSING BALANCE\s+\$?([+-]?[\d,.]+)", text, re.IGNORECASE
    )
    account_match = re.search(
        r"^\s*ACCOUNT NUMBER\s+(\d+)\s*$", text, re.MULTILINE | re.IGNORECASE
    )
    section = Section(
        short_id(
            "acct",
            statement_id,
            "robinhood-crypto",
            account_match.group(1)[-4:] if account_match else None,
        ),
        "Robinhood Crypto",
        account_match.group(1)[-4:] if account_match else None,
        "crypto",
        "USD",
        period_start_match.group(1) if period_start_match else None,
        period_end_match.group(1) if period_end_match else None,
        decimal_text(parse_decimal(opening_match.group(1)))
        if opening_match
        else None,
        decimal_text(parse_decimal(closing_match.group(1)))
        if closing_match
        else None,
        reconciliation_kind="market_value",
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    sequence = 0
    for page in pages:
        for line_number, line in enumerate(page.lines, 1):
            holding_parts = re.split(r"\s{2,}", line.strip())
            if (
                len(holding_parts) == 5
                and parse_decimal(holding_parts[1]) is not None
                and re.fullmatch(r"[A-Z][A-Z0-9.]*", holding_parts[2])
                and re.fullmatch(r"\$[\d,.]+", holding_parts[3])
                and re.fullmatch(r"\d+(?:\.\d+)?%", holding_parts[4])
            ):
                section.positions.append(
                    {
                        "symbol": holding_parts[2],
                        "description": holding_parts[0],
                        "closing_quantity": decimal_text(
                            parse_decimal(holding_parts[1])
                        ),
                        "market_value": decimal_text(
                            parse_decimal(holding_parts[3])
                        ),
                        "currency": holding_parts[2],
                        "source_page": page.page,
                        "source_line_start": line_number,
                        "source_line_end": line_number,
                        "raw_text": line.strip(),
                        "verification_status": "verified",
                    }
                )
            if not ISO_DATE_RE.search(line) or "Crypto " not in line:
                continue
            parts = re.split(r"\s{2,}", line.strip())
            if len(parts) != 7 or not ISO_DATE_RE.fullmatch(parts[0]):
                continue
            transaction_label = parts[1]
            if not transaction_label.startswith("Crypto "):
                continue
            debit_text, credit_text, price_text, value_text, fee_text = parts[2:]
            asset_text = credit_text if credit_text != "--" else debit_text
            asset_match = re.fullmatch(
                r"([\d,.]+)\s+([A-Z][A-Z0-9.]*)", asset_text
            )
            value = parse_decimal(value_text)
            unit_price = parse_decimal(price_text)
            fee = None if fee_text == "--" else parse_decimal(fee_text)
            if asset_match is None or value is None or unit_price is None:
                continue
            quantity = parse_decimal(asset_match.group(1))
            symbol = asset_match.group(2)
            normalized_label = transaction_label.lower()
            if "purchase" in normalized_label:
                amount = -abs(value)
                transaction_type = "buy"
            elif "sale" in normalized_label:
                amount = abs(value)
                transaction_type = "sell"
            elif "withdraw" in normalized_label:
                amount = -abs(value)
                transaction_type = "transfer"
            else:
                amount = abs(value)
                transaction_type = "transfer"
            sequence += 1
            transactions.append(
                make_transaction(
                    statement_id=statement_id,
                    section=section,
                    institution="Robinhood Crypto",
                    sequence=sequence,
                    transaction_date=parts[0],
                    description=f"{transaction_label} {symbol}",
                    amount=amount,
                    fee=fee,
                    quantity=quantity,
                    unit_price=unit_price,
                    symbol=symbol,
                    source_page=page.page,
                    source_line_start=line_number,
                    source_line_end=line_number,
                    raw_text=line,
                    transaction_type=transaction_type,
                    notes=(
                        "Statement value is signed by transaction semantics; "
                        "reported crypto quantity and unit price are preserved"
                    ),
                )
            )
            parsed.add((page.page, line_number))
    return [section], transactions, parsed, []


def parse_robinhood(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    def column_positions(header: str, names: list[str]) -> dict[str, int]:
        return {name: header.find(name) for name in names}

    def column_value(
        line: str,
        columns: dict[str, int],
        name: str,
        next_name: str | None,
    ) -> str:
        start = columns.get(name, -1)
        if start < 0:
            return ""
        end = columns.get(next_name, -1) if next_name else -1
        return line[start:end].strip() if end > start else line[start:].strip()

    def transaction_type(action: str, description: str) -> str:
        normalized = action.upper()
        if normalized == "BUY":
            return "buy"
        if normalized == "SELL":
            return "sell"
        if normalized == "CDIV":
            return "dividend"
        if normalized in {"FEE", "EMRF"}:
            return "fee"
        if "CANCEL" in description.upper():
            return "reversal"
        return "transfer"

    def description_from_group(
        group: list[str],
        description_end: int,
    ) -> tuple[str, str | None]:
        parts: list[str] = []
        cusip: str | None = None
        for line in group:
            left = line[:description_end].strip()
            if not left:
                continue
            cusip_match = re.search(r"CUSIP:\s*([A-Z0-9]+)", left, re.IGNORECASE)
            if cusip_match:
                cusip = cusip_match.group(1)
                left = re.sub(
                    r"CUSIP:\s*[A-Z0-9]+", "", left, flags=re.IGNORECASE
                ).strip()
            if left and left not in parts:
                parts.append(left)
        return " — ".join(parts), cusip

    sections: list[Section] = []
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    current: Section | None = None
    sequence = 0
    for page in pages:
        account_match = re.search(
            r"^\s*((?:Individual|Joint|Traditional|Roth)[^\n]*?)\s+"
            r"Account #:(\d+)\s*$",
            page.text,
            re.MULTILINE,
        )
        period_match = re.search(
            r"(\d{2}/\d{2}/20\d{2})\s+to\s+(\d{2}/\d{2}/20\d{2})",
            page.text,
        )
        if account_match and "Account Summary" in page.text:
            start = parse_us_date(period_match.group(1)) if period_match else None
            end = parse_us_date(period_match.group(2)) if period_match else None
            title = re.sub(r"\s+", " ", account_match.group(1)).strip()
            if title.startswith("Joint"):
                account_label = "Joint"
            elif title.startswith("Traditional"):
                account_label = "Traditional IRA"
            elif title.startswith("Roth"):
                account_label = "Roth IRA"
            else:
                account_label = "Individual"
            last4 = account_match.group(2)[-4:]
            name = f"Robinhood {account_label}"
            current = Section(
                short_id("acct", statement_id, "robinhood", last4),
                name,
                last4,
                "brokerage",
                "USD",
                iso(start),
                iso(end),
                reconciliation_kind="market_value",
            )
            balance_match = re.search(
                r"Portfolio Value\s+(N/?A|\$?[\d,.]+)\s+(N/?A|\$?[\d,.]+)",
                page.text,
                re.IGNORECASE,
            )
            if balance_match:
                current.opening_balance = decimal_text(
                    parse_decimal(balance_match.group(1))
                )
                current.closing_balance = decimal_text(
                    parse_decimal(balance_match.group(2))
                )
            sections.append(current)
            continue
        if current is None:
            continue

        for line_number, line in enumerate(page.lines, 1):
            parts = re.split(r"\s{2,}", line.strip())
            if (
                len(parts) >= 8
                and re.fullmatch(r"[A-Z][A-Z0-9.]*", parts[1] or "")
                and parse_decimal(parts[3]) is not None
                and parse_decimal(parts[4]) is not None
                and parse_decimal(parts[5]) is not None
                and re.fullmatch(r"\d+(?:\.\d+)?%", parts[-1] or "")
            ):
                position = {
                    "symbol": parts[1],
                    "description": parts[0],
                    "closing_quantity": decimal_text(parse_decimal(parts[3])),
                    "unit_price": decimal_text(parse_decimal(parts[4])),
                    "market_value": decimal_text(parse_decimal(parts[5])),
                    "currency": parts[1],
                    "source_page": page.page,
                    "source_line_start": line_number,
                    "source_line_end": line_number,
                    "raw_text": line.strip(),
                    "verification_status": "verified",
                }
                if not any(
                    item["symbol"] == position["symbol"]
                    and item["closing_quantity"] == position["closing_quantity"]
                    for item in current.positions
                ):
                    current.positions.append(position)

        section_kind: str | None = None
        if re.search(r"^\s*Account Activity\s*$", page.text, re.MULTILINE):
            section_kind = "account"
            column_names = [
                "Description",
                "Symbol",
                "Acct Type",
                "Transaction",
                "Date",
                "Qty",
                "Price",
                "Debit",
                "Credit",
            ]
        elif re.search(
            r"^\s*Executed Trades Pending Settlement\s*$",
            page.text,
            re.MULTILINE,
        ):
            section_kind = "pending"
            column_names = [
                "Description",
                "Acct Type",
                "Transaction",
                "Trade Date",
                "Settle Date",
                "Qty",
                "Price",
                "Debit",
                "Credit",
            ]
        else:
            continue

        header = next(
            (
                line
                for line in page.lines
                if all(
                    token in line
                    for token in (
                        "Description",
                        "Transaction",
                        "Debit",
                        "Credit",
                    )
                )
            ),
            "",
        )
        columns = column_positions(header, column_names)
        if not header or any(columns[name] < 0 for name in column_names):
            continue
        for start_line, end_line, group in nonempty_groups(page):
            joined = "\n".join(group)
            date_line = next(
                (line for line in group if US_DATE_RE.search(line)),
                "",
            )
            tx_dates = [
                parse_us_date(match.group(0))
                for match in US_DATE_RE.finditer(date_line)
            ]
            tx_dates = [value for value in tx_dates if value]
            expected_date_count = 2 if section_kind == "pending" else 1
            if len(tx_dates) < expected_date_count:
                continue
            debit = parse_decimal(
                column_value(date_line, columns, "Debit", "Credit")
            )
            credit = parse_decimal(
                column_value(date_line, columns, "Credit", None)
            )
            if debit is None and credit is None:
                continue
            amount = credit if credit is not None else -abs(debit or Decimal("0"))
            description_end = (
                columns["Symbol"]
                if section_kind == "account"
                else columns["Acct Type"]
            )
            description, cusip = description_from_group(
                group,
                description_end,
            )
            action = column_value(
                date_line,
                columns,
                "Transaction",
                "Trade Date" if section_kind == "pending" else "Date",
            )
            symbol = (
                column_value(date_line, columns, "Symbol", "Acct Type")
                if section_kind == "account"
                else None
            ) or None
            quantity = parse_decimal(
                column_value(date_line, columns, "Qty", "Price")
            )
            unit_price = parse_decimal(
                column_value(date_line, columns, "Price", "Debit")
            )
            tx_date = tx_dates[0]
            settle_date = tx_dates[1] if section_kind == "pending" else None
            notes_parts = []
            if cusip:
                notes_parts.append(f"CUSIP {cusip}")
            if section_kind == "pending":
                notes_parts.append(
                    "Executed trade pending settlement; may repeat in a later "
                    "statement's Account Activity"
                )
            sequence += 1
            transactions.append(
                make_transaction(
                    statement_id=statement_id,
                    section=current,
                    institution="Robinhood",
                    sequence=sequence,
                    transaction_date=iso(tx_date),
                    description=description,
                    amount=amount,
                    source_page=page.page,
                    source_line_start=start_line,
                    source_line_end=end_line,
                    raw_text=joined,
                    transaction_type=transaction_type(action, description),
                    posted_date=iso(settle_date),
                    quantity=quantity,
                    unit_price=unit_price,
                    symbol=symbol,
                    notes="; ".join(notes_parts) or None,
                )
            )
            parsed.update(
                (page.page, line_number)
                for line_number in range(start_line, end_line + 1)
            )
    return sections, transactions, parsed, []


def parse_generic(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    period_start, period_end = find_period(text)
    section = Section(
        short_id("acct", statement_id, "generic"),
        "Unknown account",
        None,
        "unknown",
        "USD",
        period_start,
        period_end,
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    sequence = 0
    for page in pages:
        for index, line in enumerate(page.lines, 1):
            tx_date = parse_us_date(line) or parse_spanish_date(line)
            values = [parse_decimal(match.group(0)) for match in MONEY_RE.finditer(line)]
            values = [value for value in values if value is not None]
            if not tx_date or not values:
                continue
            sequence += 1
            transactions.append(
                make_transaction(
                    statement_id=statement_id,
                    section=section,
                    institution="Unknown",
                    sequence=sequence,
                    transaction_date=iso(tx_date),
                    description=line.strip(),
                    amount=values[-1],
                    source_page=page.page,
                    source_line_start=index,
                    source_line_end=index,
                    raw_text=line,
                    notes="Generic parser; manual verification required",
                )
            )
            parsed.add((page.page, index))
    return [section], transactions, parsed, ["Unsupported layout parsed generically"]


def parse_verified_transcription(
    transcription: dict[str, Any],
    *,
    source_hash: str,
    detected_institution: str,
    statement_id: str,
    pages: list[SourcePage],
) -> tuple[str, list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    """Load a hash-bound visual transcription when embedded PDF text is unusable."""
    if transcription.get("source_sha256") != source_hash:
        raise ValueError("verified transcription source_sha256 does not match source")
    institution = str(transcription.get("institution") or detected_institution).strip()
    if detected_institution != "Unknown" and institution != detected_institution:
        raise ValueError(
            "verified transcription institution does not match detected institution"
        )
    section_data = transcription.get("section")
    if not isinstance(section_data, dict):
        raise ValueError("verified transcription must contain one section object")
    required_section_fields = (
        "account_name",
        "account_type",
        "currency",
        "period_start",
        "period_end",
    )
    missing_section_fields = [
        field
        for field in required_section_fields
        if section_data.get(field) in (None, "")
    ]
    if missing_section_fields:
        raise ValueError(
            "verified transcription section is missing: "
            + ", ".join(missing_section_fields)
        )
    missing_balance_keys = [
        field
        for field in ("opening_balance", "closing_balance")
        if field not in section_data
    ]
    if missing_balance_keys:
        raise ValueError(
            "verified transcription section must explicitly classify: "
            + ", ".join(missing_balance_keys)
        )
    section = Section(
        short_id(
            "acct",
            statement_id,
            "verified-transcription",
            section_data.get("account_last4") or "",
        ),
        str(section_data["account_name"]),
        (
            str(section_data["account_last4"])
            if section_data.get("account_last4") not in (None, "")
            else None
        ),
        str(section_data["account_type"]),
        str(section_data["currency"]),
        str(section_data["period_start"]),
        str(section_data["period_end"]),
        (
            decimal_text(parse_decimal(str(section_data["opening_balance"])))
            if section_data["opening_balance"] is not None
            else None
        ),
        (
            decimal_text(parse_decimal(str(section_data["closing_balance"])))
            if section_data["closing_balance"] is not None
            else None
        ),
        str(section_data.get("reconciliation_kind") or "cash"),
    )
    parsed: set[tuple[int, int]] = set()
    if transcription.get("embedded_text_unusable") is True:
        warnings = transcription.get("warnings")
        if not isinstance(warnings, list) or not warnings:
            raise ValueError(
                "embedded_text_unusable requires a visual-transcription warning"
            )
        parsed.update(
            (page.page, line_number)
            for page in pages
            for line_number, line in enumerate(page.lines, 1)
            if MONEY_RE.search(line)
        )
    for locator in transcription.get("classified_money_lines") or []:
        if not isinstance(locator, dict):
            raise ValueError("classified_money_lines entries must be objects")
        parsed.add((int(locator["page"]), int(locator["line"])))
    page_count = len(pages)
    transactions: list[dict[str, Any]] = []
    rows = transcription.get("transactions")
    if not isinstance(rows, list):
        raise ValueError("verified transcription transactions must be a list")
    for sequence, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError("verified transcription transaction must be an object")
        source_page = int(row["source_page"])
        source_page_end = int(row.get("source_page_end") or source_page)
        line_start = int(row["source_line_start"])
        line_end = int(row["source_line_end"])
        if not 1 <= source_page <= source_page_end <= page_count:
            raise ValueError("verified transaction page locator is out of range")
        amount = parse_decimal(str(row["amount"]))
        if amount is None:
            raise ValueError("verified transaction amount is invalid")
        transaction_date = str(row["transaction_date"])
        try:
            date.fromisoformat(transaction_date)
        except ValueError as exc:
            raise ValueError("verified transaction date is invalid") from exc
        raw_text = str(row.get("raw_text") or "").strip()
        if not raw_text:
            raise ValueError("verified transaction raw_text is required")
        transaction_type = str(row.get("transaction_type") or "").strip()
        if not transaction_type or transaction_type == "unknown":
            raise ValueError("verified transaction_type must be explicit")
        transactions.append(
            make_transaction(
                statement_id=statement_id,
                section=section,
                institution=institution,
                sequence=sequence,
                transaction_date=transaction_date,
                posted_date=(
                    str(row["posted_date"]) if row.get("posted_date") else None
                ),
                description=str(row["description"]),
                amount=amount,
                source_page=source_page,
                source_page_end=source_page_end,
                source_line_start=line_start,
                source_line_end=line_end,
                raw_text=raw_text,
                transaction_type=transaction_type,
                fee=parse_decimal(str(row["fee"])) if row.get("fee") else None,
                balance=(
                    parse_decimal(str(row["balance"])) if row.get("balance") else None
                ),
                quantity=(
                    parse_decimal(str(row["quantity"]))
                    if row.get("quantity")
                    else None
                ),
                unit_price=(
                    parse_decimal(str(row["unit_price"]))
                    if row.get("unit_price")
                    else None
                ),
                symbol=str(row["symbol"]) if row.get("symbol") else None,
                external_id=(
                    str(row["external_id"]) if row.get("external_id") else None
                ),
                notes=str(row["notes"]) if row.get("notes") else None,
            )
        )
        if source_page == source_page_end:
            parsed.update(
                (source_page, line_number)
                for line_number in range(line_start, line_end + 1)
            )
    return (
        institution,
        [section],
        transactions,
        parsed,
        [str(item) for item in transcription.get("warnings") or []],
    )


def reconcile_sections(
    sections: list[Section], transactions: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for section in sections:
        reported_activity = sum(
            (
                Decimal(tx["amount"])
                for tx in transactions
                if tx["account_section_id"] == section.account_section_id
            ),
            Decimal("0"),
        )
        activity = reported_activity
        if section.reconciliation_kind == "venmo_cash":
            activity = sum(
                (
                    Decimal(tx["amount"])
                    for tx in transactions
                    if tx["account_section_id"] == section.account_section_id
                    and tx.get("notes")
                    and json.loads(str(tx["notes"])).get("affects_venmo_cash_balance")
                ),
                Decimal("0"),
            )
        opening = parse_decimal(section.opening_balance)
        closing = parse_decimal(section.closing_balance)
        computed = opening + activity if opening is not None else None
        difference = computed - closing if computed is not None and closing is not None else None
        if section.reconciliation_kind == "market_value":
            status = "market_value_review"
        elif difference is None:
            status = "insufficient_balance_data"
        elif abs(difference) <= Decimal("0.01"):
            status = "pass"
        else:
            status = "fail"
        result = asdict(section)
        result.update(
            {
                "parsed_activity_total": decimal_text(activity),
                "reported_transaction_total": decimal_text(reported_activity),
                "computed_closing_balance": decimal_text(computed),
                "difference": decimal_text(difference),
                "status": status,
            }
        )
        results.append(result)
    return results


def verified_evidence(
    review_section: dict[str, Any],
    field: str,
    *,
    amount: str | None = None,
    currency: str | None = None,
) -> dict[str, Any]:
    evidence = review_section.get(field)
    if not isinstance(evidence, dict):
        evidence = {}
    included = amount is not None
    return {
        "included": included,
        "amount": amount,
        "currency": currency if included else None,
        "source_page": evidence.get("source_page"),
        "source_line_start": evidence.get("source_line_start"),
        "source_line_end": evidence.get("source_line_end"),
        "raw_text": evidence.get("raw_text"),
        "verification_status": (
            "verified"
            if evidence.get("verified") is True and included
            else "verified_absent"
            if evidence.get("verified") is True and not included
            else "unverified"
        ),
    }


def build_clean_statements(
    sections: list[Section],
    transactions: list[dict[str, Any]],
    visual_review: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    review_sections = {
        item.get("account_section_id"): item
        for item in ((visual_review or {}).get("sections") or [])
        if isinstance(item, dict)
    }
    clean: list[dict[str, Any]] = []
    for section in sections:
        review_section = review_sections.get(section.account_section_id, {})
        date_evidence = review_section.get("date_range")
        if not isinstance(date_evidence, dict):
            date_evidence = {}
        clean.append(
            {
                "account_section_id": section.account_section_id,
                "account": {
                    "name": section.account_name,
                    "last4": section.account_last4,
                    "type": section.account_type,
                    "currency": section.currency,
                },
                "date_range": {
                    "start": section.period_start,
                    "end": section.period_end,
                    "source_page": date_evidence.get("source_page"),
                    "source_line_start": date_evidence.get("source_line_start"),
                    "source_line_end": date_evidence.get("source_line_end"),
                    "raw_text": date_evidence.get("raw_text"),
                    "verification_status": (
                        "verified"
                        if date_evidence.get("verified") is True
                        else "unverified"
                    ),
                },
                "starting_balance": verified_evidence(
                    review_section,
                    "starting_balance",
                    amount=section.opening_balance,
                    currency=section.currency,
                ),
                "transactions": [
                    transaction
                    for transaction in transactions
                    if transaction["account_section_id"] == section.account_section_id
                ],
                "ending_balance": verified_evidence(
                    review_section,
                    "ending_balance",
                    amount=section.closing_balance,
                    currency=section.currency,
                ),
                "positions": section.positions,
            }
        )
    return clean


def validate_visual_review(
    visual_review: dict[str, Any] | None,
    *,
    source_hash: str,
    pages: list[dict[str, Any]],
    sections: list[Section],
    transactions: list[dict[str, Any]],
    warnings: list[str],
) -> list[str]:
    errors: list[str] = []
    if not isinstance(visual_review, dict):
        return ["Visual review is required before a bundle can be imported"]
    if not str(visual_review.get("reviewer") or "").strip():
        errors.append("Visual review must identify the reviewer")
    if not str(visual_review.get("reviewed_at") or "").strip():
        errors.append("Visual review must include a reviewed_at timestamp")
    if visual_review.get("source_sha256") != source_hash:
        errors.append("Visual review source_sha256 does not match the statement")
    expected_pages = sorted(
        page["page"] for page in pages if isinstance(page.get("page"), int)
    )
    reviewed_pages = sorted(
        page
        for page in visual_review.get("reviewed_pages", [])
        if isinstance(page, int)
    )
    if reviewed_pages != expected_pages:
        errors.append("Visual review must explicitly cover every PDF page")
    if visual_review.get("all_money_lines_classified") is not True:
        errors.append("Visual review must classify every money-bearing source line")
    if sorted(visual_review.get("resolved_warnings") or []) != sorted(warnings):
        errors.append("Visual review must explicitly resolve every parser warning")
    review_sections = {
        item.get("account_section_id"): item
        for item in (visual_review.get("sections") or [])
        if isinstance(item, dict)
    }
    for section in sections:
        item = review_sections.get(section.account_section_id)
        if not isinstance(item, dict):
            errors.append(
                f"Missing visual review for section {section.account_section_id}"
            )
            continue
        date_range = item.get("date_range")
        if not isinstance(date_range, dict) or date_range.get("verified") is not True:
            errors.append(
                f"Date range is not visually verified for {section.account_section_id}"
            )
        else:
            if (
                date_range.get("start") != section.period_start
                or date_range.get("end") != section.period_end
            ):
                errors.append(
                    f"Visual date range disagrees for {section.account_section_id}"
                )
            if not section.period_start or not section.period_end:
                errors.append(
                    f"Date range is incomplete for {section.account_section_id}"
                )
            if not date_range.get("raw_text"):
                errors.append(
                    f"Date range evidence is missing for {section.account_section_id}"
                )
        for field, amount in (
            ("starting_balance", section.opening_balance),
            ("ending_balance", section.closing_balance),
        ):
            evidence = item.get(field)
            if not isinstance(evidence, dict) or evidence.get("verified") is not True:
                errors.append(
                    f"{field} is not visually verified for {section.account_section_id}"
                )
                continue
            if evidence.get("included") is not (amount is not None):
                errors.append(
                    f"{field} presence disagrees for {section.account_section_id}"
                )
            if amount is not None:
                try:
                    same_amount = Decimal(str(evidence.get("amount"))) == Decimal(amount)
                except (InvalidOperation, TypeError):
                    same_amount = False
                if not same_amount:
                    errors.append(
                        f"{field} amount disagrees for {section.account_section_id}"
                    )
                if not evidence.get("raw_text"):
                    errors.append(
                        f"{field} evidence is missing for {section.account_section_id}"
                    )
        section_transaction_count = sum(
            transaction["account_section_id"] == section.account_section_id
            for transaction in transactions
        )
        section_transaction_ids = sorted(
            transaction["transaction_id"]
            for transaction in transactions
            if transaction["account_section_id"] == section.account_section_id
        )
        if item.get("transactions_verified") is not True:
            errors.append(
                f"Transactions are not visually verified for {section.account_section_id}"
            )
        if item.get("transaction_count") != section_transaction_count:
            errors.append(
                f"Visual transaction count disagrees for {section.account_section_id}"
            )
        if sorted(item.get("verified_transaction_ids") or []) != section_transaction_ids:
            errors.append(
                f"Every transaction ID must be individually verified for "
                f"{section.account_section_id}"
            )
        if section.positions:
            verified_positions = [
                {
                    "symbol": position.get("symbol"),
                    "opening_quantity": position.get("opening_quantity"),
                    "closing_quantity": position.get("closing_quantity"),
                    "source_page": position.get("source_page"),
                    "source_line_start": position.get("source_line_start"),
                    "source_line_end": position.get("source_line_end"),
                    "raw_text": position.get("raw_text"),
                }
                for position in section.positions
            ]
            if item.get("positions_verified") is not True:
                errors.append(
                    f"Positions are not visually verified for "
                    f"{section.account_section_id}"
                )
            if item.get("verified_positions") != verified_positions:
                errors.append(
                    f"Every position must be individually verified for "
                    f"{section.account_section_id}"
                )
    return errors


def ignored_money_line(text: str) -> str | None:
    patterns = {
        r"^\s*(Total|TOTAL|All Accounts|Portfolio Value|Total Securities|Net Account Balance)": "statement summary",
        r"^\s*(Beginning Account Value|Deposits|Dividend & Interest|Withdrawals|Other Activity|Net Change in Portfolio Value|Ending Account Value|Cash & Cash Equivalents|Equities|Options|Fixed Income|Mutual Funds|Other Assets|Cash Balance|Margin Balance|Short Balance|US Dollar)\b": "brokerage valuation or balance summary",
        r"(Minimum Payment|Payment Due|YTD|Year-to-date|APY|rendimiento|GAT|saldo promedio)": "disclosure or summary",
        r"Periodo:.*20\d{2}.*\(\d+\s+d[ií]as\)": "statement period metadata",
        r"(Opening (?:.* )?Balance|Closing (?:.* )?Balance|Beginning Balance|Ending Balance|Saldo inicial|Saldo al generar|Balance on|Previous .*Balance|Your .* Balance|Money In|Money Out)": "balance metadata",
        r"Available (?:beginning|ending)": "balance metadata",
        r"(Comisiones|Resumen de comisiones|fees|Fees)": "fee summary",
        r"(Annual Percentage|percentage yield|interés bruto|impuestos|Daily Cash|Dividends|Savings Interest|Capital Gains|Interest Earned|Stock Lending|THIS PERIOD|Contributions|Distributions)": "rate or income summary",
        r"^\s*\$[\d,.]+\s+\$[\d,.]+\s*(?:[A-Za-z]{3}\s+\d{1,2},\s+20\d{2})?\s*$": "multi-column balance summary",
        r"(recurring payment|balance of \$[\d,.]+ for|Total interest charged|credit bureaus|Late payments)": "card disclosure or summary",
        r"You have money waiting:.*\b[A-Z]{3}\s+[\d,.]+": "unaccepted payment alert",
        r"^(?:\s*[—–-]\s*)+\$0\.00\s*$": "zero-value summary",
        r"^\s*Total interest (?:for this month|charged)\s+\$[\d,.]+\s*$": "interest summary",
        r"^\s*(Depósitos|Gastos)\s+[+-]?\$[\d,.]+\s*$": "account activity summary",
        r"^\s*(Interest Paid|Daily Cash Deposits|Other Deposits|Withdrawals)\b.*\$[\d,.]+": "account activity summary",
        r"(Dinero generado este mes|Disponible 24/7|Congelado|UDIS|Recuerda que las obtendrás desde|teléfono \+\d)": "account disclosure or summary",
        r"(Saldo total del periodo|Pago para no generar intereses|Pago m[ií]nimo|Capital:|Intereses:|IVA:)": "Nu credit balance or payment summary",
        r"(L[ií]mite de cr[ée]dito|L[ií]mite disponible|Compras, retiros y mensualidades|Intereses a pagar|Saldo total pendiente a meses)": "Nu credit utilization summary",
        r"^\s*(Pagos a tu tarjeta en el periodo|Compras|Abonos y devoluciones|Retiros de efectivo|Intereses de saldo|Intereses de disposiciones|Disposiciones de Saldo|IVA|Saldo a meses|Saldo a favor|Tasa de saldo a favor)\b": "Nu credit activity summary",
        r"(Saldo actual al corte|Saldo final del periodo|Saldo cargos regulares|Saldo cargos a meses|Saldo deudor total|Cr[ée]dito disponible)": "Nu credit balance summary",
        r"(Adeudo del periodo anterior|Cargos regulares|Cargos y compras a meses|Pagos y abonos|PAGO PARA NO GENERAR INTERESES)": "Nu credit reconciliation summary",
        r"(Intereses pagados|Monto de intereses pagados|Monto de comisiones totales|Monto de anualidad|Monto sobre el que se generan|Impuesto al Valor Agregado)": "Nu credit cost summary",
        r"(Tu compra m[aá]s grande|fue de \$|con \$[\d,.]+|Para liquidar tu saldo total|Mastercard, aceptan Nu)": "Nu credit insight or payment illustration",
        r"\$[\d,.]+\s+pesos\.": "Nu credit insight summary",
        r"N[uú]mero de tarjeta:.*\$[\d,.]+\s*$": "Nu credit balance summary",
        r"(Puedes elegir compras arriba de \$|La cantidad m[ií]nima a diferir es de \$|^\s*\$100 M\.N\.|Para dudas o m[aá]s informaci[oó]n, llama|Tel[ée]fono:\s*\+\d)": "Nu credit terms or support disclosure",
        r"^\s*(Ordinarios|Moratorios|De compras y cargos diferidos a)\b.*\$[\d,.]+": "Nu interest-rate summary",
        r"^\s*\$[\d,.]+(?:\s+\$[\d,.]+){2,}\s*$": "Nu payment allocation summary",
        r"(Periodo seleccionado|Mes calendario anterior|Año actual|llámanos al|Wise US Inc\.|número de empresa 7209813|Tel:\s*\+44)": "fee, regulatory, or support disclosure",
        r"^\s*\$[\d,.]+\s+IN ALL ACCOUNTS\s*$": "combined account summary",
        r"^\s*360 .*\$[\d,.]+\s+\$[\d,.]+\s*$": "combined account summary",
        r"^\s*360 .* - \d+\s*$": "account heading",
        r"^\s*\d+(?:\.\d+)?%\s+\$[\d,.]+\s+\d+\s*$": "rate summary",
        r"^\s*(?:\d+(?:\.\d+)?%)\s*$": "portfolio percentage",
        r"^\s*(?:[A-Z][A-Z0-9.]*\s+\(\d+(?:\.\d+)?%\)\s*)+$": "portfolio allocation snapshot",
        r"^\s*[A-Za-z][A-Za-z ]+\s+\d[\d,.]*\s+[A-Z][A-Z0-9.]*\s+\$[\d,.]+\s+\d+(?:\.\d+)?%\s*$": "cryptocurrency holding snapshot",
        r"\bMargin\b.*\$[\d,.]+.*%": "portfolio holding snapshot",
        r"(Estimated Yield|Brokerage Cash Balance|Deposit Sweep Balance)": "portfolio summary",
        r"^\s*(?:FDIC Sweep|Brokerage-held Cash)\s+\d{2}/\d{2}/20\d{2}\b": "brokerage internal cash movement",
        r"^\s*(?:Citibank|Goldman Sachs|M&T|US Bank|Morgan Stanley(?: Private)? Bank)\s+\$[\d,.]+\s*$": "deposit sweep allocation snapshot",
        r"^\s*[A-Za-z][A-Za-z0-9 &.-]*\s+[A-Z][A-Z0-9.]*\s+(?:Cash|Margin)\s+[\d,.]+\s+\$[\d,.]+\s+\$[\d,.]+(?:\s+\$[\d,.]+)?\s+\d+(?:\.\d+)?%\s*$": "portfolio holding snapshot",
        r"^\s*(?:Early IRA Match Removal Fee|Transaction Fee)\s+\(?\$[\d,.]+\)?(?:\s+\(?\$[\d,.]+\)?)+\s*$": "retirement or fee summary",
        r"^\s*\$[\d,.]+\s+\d+(?:\.\d+)?%\s+\$[\d,.]+\s+\d+(?:\.\d+)?%\s+\$[\d,.]+\s+\d+(?:\.\d+)?%\s*$": "portfolio allocation snapshot",
        r"(Member of SIPC|net capital of \$|required net capital|capital of \$[\d,.]+|debit card transactions.*statement|Robinhood Gold Card|Visa U\.S\.A\. Inc\.|paper copy may be requested at no cost by calling)": "regulatory disclosure",
        r"If married filing separately, use \$[\d,.]+ instead": "retirement tax disclosure",
        r"(money market mutual funds.*\$1|FDIC up to \$|preserve their value at \$1)": "brokerage disclosure",
        r"(customers who (?:receive|spend)|all customers will be charged|minimum fee range)": "account terms disclosure",
        r"\b(?:UTC|GMT)\s*[+-]\d{1,2}:\d{2}\b": "time-zone disclosure",
        r"^\s*(?:Page|Página)\s+\d+|^\s*\d+\s*/\s*\d+\s*$": "page footer",
    }
    for pattern, reason in patterns.items():
        if re.search(pattern, text, re.IGNORECASE):
            return reason
    return None


def build_audit(
    pages: list[SourcePage], parsed: set[tuple[int, int]], warnings: list[str]
) -> dict[str, Any]:
    unparsed: list[dict[str, Any]] = []
    ignored: list[dict[str, Any]] = []
    for page in pages:
        for index, line in enumerate(page.lines, 1):
            if not MONEY_RE.search(line) or (page.page, index) in parsed:
                continue
            reason = ignored_money_line(line)
            target = ignored if reason else unparsed
            item = {"page": page.page, "line": index, "text": line}
            if reason:
                item["reason"] = reason
            target.append(item)
    return {
        "schema_version": SCHEMA_VERSION,
        "pages": [asdict(page) for page in pages],
        "unparsed_money_lines": unparsed,
        "ignored_money_lines": ignored,
        "warnings": warnings,
        "visual_review_notes": [],
    }


def parse_csv_source(
    path: Path, statement_id: str
) -> tuple[str, list[Section], list[dict[str, Any]], dict[str, Any]]:
    source_text = path.read_text(encoding="utf-8-sig")
    first_row = next(csv.reader(io.StringIO(source_text)), [])
    if set(
        [
            "Transaction ID",
            "Date",
            "Transaction Type",
            "Currency",
            "Amount",
            "Fee",
            "Net Amount",
            "Asset Type",
            "Asset Price",
            "Asset Amount",
        ]
    ).issubset(first_row):
        return parse_cash_app_bitcoin_csv(path, statement_id, source_text)
    if (
        "Account Statement - (@" in source_text
        and "Amount (total)" in source_text
        and "Statement Period Venmo Fees" in source_text
    ):
        return parse_venmo_csv(path, statement_id, source_text)
    source_lines = source_text.splitlines()
    header_index = 0
    for index, line in enumerate(source_lines):
        normalized = re.sub(r"\W+", "_", line.lower())
        if "date" in normalized and "amount" in normalized:
            header_index = index
            break
    table_text = "\n".join(source_lines[header_index:])
    sample = table_text[:8192]
    dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    rows = list(csv.DictReader(io.StringIO(table_text), dialect=dialect))
    section = Section(
        short_id("acct", statement_id, "csv"),
        path.stem,
        None,
        "unknown",
        "USD",
        None,
        None,
    )
    transactions: list[dict[str, Any]] = []
    for sequence, row in enumerate(rows, 1):
        normalized = {re.sub(r"\W+", "_", key.lower()).strip("_"): value for key, value in row.items()}
        date_value = next(
            (normalized[key] for key in normalized if "date" in key and normalized[key]),
            "",
        )
        iso_match = ISO_DATE_RE.search(date_value)
        tx_date = (
            date(
                int(iso_match.group(1)),
                int(iso_match.group(2)),
                int(iso_match.group(3)),
            )
            if iso_match
            else parse_us_date(date_value)
        )
        amount_value = next(
            (
                normalized[key]
                for key in normalized
                if key in {"amount", "amount_total", "net_amount"}
                and normalized[key]
            ),
            "",
        )
        if not amount_value:
            amount_value = next(
                (
                    normalized[key]
                    for key in normalized
                    if "amount" in key
                    and not any(
                        excluded in key
                        for excluded in ("tip", "tax", "fee", "balance")
                    )
                    and normalized[key]
                ),
                "",
            )
        amount = parse_decimal(amount_value)
        if amount is None:
            continue
        description = next(
            (
                normalized[key]
                for key in normalized
                if any(term in key for term in ("description", "note", "merchant"))
                and normalized[key]
            ),
            "CSV transaction",
        )
        transactions.append(
            make_transaction(
                statement_id=statement_id,
                section=section,
                institution="CSV",
                sequence=sequence,
                transaction_date=iso(tx_date),
                description=description,
                amount=amount,
                source_page=1,
                source_line_start=sequence + 1,
                source_line_end=sequence + 1,
                raw_text=json.dumps(row, ensure_ascii=False),
            )
        )
    audit = {
        "schema_version": SCHEMA_VERSION,
        "pages": [],
        "unparsed_money_lines": [],
        "ignored_money_lines": [],
        "warnings": [],
        "visual_review_notes": ["Verify the source CSV column mapping."],
    }
    return "CSV", [section], transactions, audit


def parse_cash_app_bitcoin_csv(
    path: Path,
    statement_id: str,
    source_text: str,
) -> tuple[str, list[Section], list[dict[str, Any]], dict[str, Any]]:
    rows = list(csv.DictReader(io.StringIO(source_text)))
    if not rows:
        raise ValueError("Cash App Bitcoin CSV contains no transactions")

    type_map = {
        "bitcoin sale": "sell",
        "bitcoin buy": "buy",
        "bitcoin deposit": "transfer",
        "bitcoin lightning deposit": "transfer",
        "bitcoin received p2p": "transfer",
        "bitcoin withdrawal": "crypto_send",
        "bitcoin lightning withdrawal": "crypto_send",
        "bitcoin sent p2p": "crypto_send",
    }
    parsed_rows: list[dict[str, Any]] = []
    transaction_dates: list[date] = []
    seen_ids: set[str] = set()
    for source_line, row in enumerate(rows, 2):
        external_id = (row.get("Transaction ID") or "").strip()
        if not external_id:
            raise ValueError(
                f"Cash App Bitcoin CSV row {source_line} has no transaction ID"
            )
        if external_id in seen_ids:
            raise ValueError(
                f"Cash App Bitcoin CSV repeats transaction ID {external_id!r}"
            )
        seen_ids.add(external_id)

        date_text = (row.get("Date") or "").strip()
        date_match = ISO_DATE_RE.search(date_text)
        if not date_match:
            raise ValueError(
                f"Cash App Bitcoin transaction {external_id} has no valid date"
            )
        transaction_date = date(
            int(date_match.group(1)),
            int(date_match.group(2)),
            int(date_match.group(3)),
        )
        transaction_dates.append(transaction_date)

        source_type = (row.get("Transaction Type") or "").strip()
        transaction_type = type_map.get(source_type.lower())
        if transaction_type is None:
            raise ValueError(
                f"Cash App Bitcoin transaction {external_id} has unsupported "
                f"type {source_type!r}"
            )

        currency = (row.get("Currency") or "").strip().upper()
        symbol = (row.get("Asset Type") or "").strip().upper()
        if currency != "USD" or symbol != "BTC":
            raise ValueError(
                f"Cash App Bitcoin transaction {external_id} has unexpected "
                f"currency/asset {currency!r}/{symbol!r}"
            )

        gross_amount = parse_decimal(row.get("Amount"))
        fee = parse_decimal(row.get("Fee"))
        net_amount = parse_decimal(row.get("Net Amount"))
        unit_price = parse_decimal(row.get("Asset Price"))
        asset_amount_text = (row.get("Asset Amount") or "").strip()
        quantity = parse_decimal(
            re.sub(r"\s+[A-Za-z][A-Za-z0-9.]*\s*$", "", asset_amount_text)
        )
        if any(
            value is None
            for value in (gross_amount, fee, net_amount, unit_price, quantity)
        ):
            raise ValueError(
                f"Cash App Bitcoin transaction {external_id} has an "
                "incomplete amount, fee, price, or quantity"
            )
        if not asset_amount_text.upper().endswith(" BTC"):
            raise ValueError(
                f"Cash App Bitcoin transaction {external_id} has an "
                f"unexpected asset amount {asset_amount_text!r}"
            )
        if gross_amount + fee != net_amount:
            raise ValueError(
                f"Cash App Bitcoin transaction {external_id} does not satisfy "
                "gross amount + fee = net amount"
            )
        if quantity <= 0 or unit_price <= 0:
            raise ValueError(
                f"Cash App Bitcoin transaction {external_id} has a "
                "non-positive quantity or unit price"
            )
        parsed_rows.append(
            {
                "source_line": source_line,
                "row": row,
                "external_id": external_id,
                "transaction_date": transaction_date,
                "source_type": source_type,
                "transaction_type": transaction_type,
                "gross_amount": gross_amount,
                "fee": fee,
                "net_amount": net_amount,
                "unit_price": unit_price,
                "quantity": quantity,
                "timezone": date_text.rsplit(" ", 1)[-1],
            }
        )

    period_start = min(transaction_dates)
    period_end = max(transaction_dates)
    section = Section(
        short_id("acct", statement_id, "cash-app-bitcoin"),
        "Cash App Bitcoin",
        None,
        "crypto",
        "USD",
        iso(period_start),
        iso(period_end),
    )
    transactions = [
        make_transaction(
            statement_id=statement_id,
            section=section,
            institution="Cash App Bitcoin",
            sequence=sequence,
            transaction_date=iso(item["transaction_date"]),
            description=item["source_type"],
            amount=item["net_amount"],
            fee=item["fee"],
            quantity=item["quantity"],
            unit_price=item["unit_price"],
            symbol="BTC",
            external_id=item["external_id"],
            source_page=1,
            source_line_start=item["source_line"],
            source_line_end=item["source_line"],
            raw_text=json.dumps(
                item["row"],
                ensure_ascii=False,
                sort_keys=True,
            ),
            transaction_type=item["transaction_type"],
            notes=json.dumps(
                {
                    "gross_amount": decimal_text(item["gross_amount"]),
                    "net_amount": decimal_text(item["net_amount"]),
                    "source_timezone": item["timezone"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        for sequence, item in enumerate(parsed_rows, 1)
    ]
    audit = {
        "schema_version": SCHEMA_VERSION,
        "pages": [],
        "unparsed_money_lines": [],
        "ignored_money_lines": [],
        "warnings": [],
        "visual_review_notes": [
            (
                "Cash App Bitcoin transaction-history CSV; opening and closing "
                "balances are not supplied by this source."
            )
        ],
    }
    return "Cash App Bitcoin", [section], transactions, audit


def parse_venmo_csv(
    path: Path, statement_id: str, source_text: str
) -> tuple[str, list[Section], list[dict[str, Any]], dict[str, Any]]:
    rows = list(csv.reader(io.StringIO(source_text)))
    header_index = next(
        (
            index
            for index, row in enumerate(rows)
            if "ID" in row and "Amount (total)" in row
        ),
        None,
    )
    if header_index is None:
        raise ValueError("Venmo CSV does not contain its transaction header")
    headers = [value.strip() for value in rows[header_index]]
    records: list[dict[str, str]] = []
    for row in rows[header_index + 1 :]:
        padded = row + [""] * max(0, len(headers) - len(row))
        records.append(dict(zip(headers, padded[: len(headers)])))

    period_match = re.search(r"venmo_(20\d{2})-(\d{2})$", path.stem, re.IGNORECASE)
    if not period_match:
        raise ValueError("Venmo CSV filename must identify its statement month")
    year, month = (int(value) for value in period_match.groups())
    period_start = date(year, month, 1)
    period_end = date(year, month, calendar.monthrange(year, month)[1])
    opening = next(
        (
            parse_decimal(row.get("Beginning Balance"))
            for row in records
            if parse_decimal(row.get("Beginning Balance")) is not None
        ),
        None,
    )
    closing = next(
        (
            parse_decimal(row.get("Ending Balance"))
            for row in records
            if parse_decimal(row.get("Ending Balance")) is not None
        ),
        None,
    )
    if opening is None or closing is None:
        raise ValueError("Venmo CSV must include beginning and ending cash balances")
    crypto_summary: dict[str, dict[str, Decimal]] = {}
    for index, row in enumerate(rows):
        if (
            row
            and (row[0] or "").strip() == "Cryptocurrency summary"
            and index + 3 < len(rows)
        ):
            symbol_name = (rows[index + 1][2] or "").strip()
            beginning_label = (rows[index + 2][1] or "").strip()
            ending_label = (rows[index + 3][1] or "").strip()
            beginning_value = parse_decimal(rows[index + 2][2])
            ending_value = parse_decimal(rows[index + 3][2])
            if (
                symbol_name
                and beginning_label == "Available beginning"
                and ending_label == "Available ending"
                and beginning_value is not None
                and ending_value is not None
            ):
                crypto_summary[symbol_name] = {
                    "opening": beginning_value,
                    "closing": ending_value,
                }
    section = Section(
        short_id("acct", statement_id, "venmo-cash"),
        "Venmo",
        None,
        "payment",
        "USD",
        iso(period_start),
        iso(period_end),
        decimal_text(opening),
        decimal_text(closing),
        "venmo_cash",
    )
    for name, values in crypto_summary.items():
        symbol = {"Bitcoin": "BTC"}.get(name, name.upper())
        section.positions.append(
            {
                "symbol": symbol,
                "description": name,
                "opening_quantity": decimal_text(values["opening"]),
                "closing_quantity": decimal_text(values["closing"]),
                "currency": symbol,
                "source_page": 1,
                "source_line_start": None,
                "source_line_end": None,
                "raw_text": (
                    f"{name} Available beginning "
                    f"{decimal_text(values['opening'])}; Available ending "
                    f"{decimal_text(values['closing'])}"
                ),
                "verification_status": "verified",
            }
        )
    type_map = {
        "payment": "payment",
        "standard transfer": "transfer",
        "instant transfer": "transfer",
        "bitcoin send": "crypto_send",
    }
    transactions: list[dict[str, Any]] = []
    for record_number, row in enumerate(records, 1):
        external_id = (row.get("ID") or "").strip()
        if not external_id.isdigit():
            continue
        date_value = (row.get("Datetime") or "").strip()
        try:
            transaction_date = datetime.fromisoformat(date_value).date()
        except ValueError:
            raise ValueError(f"Venmo transaction {external_id} has no valid date")
        amount = parse_decimal(row.get("Amount (total)"))
        if amount is None:
            raise ValueError(f"Venmo transaction {external_id} has no amount")
        source_type = (row.get("Type") or "").strip()
        transaction_type = type_map.get(source_type.lower())
        if not transaction_type:
            raise ValueError(
                f"Venmo transaction {external_id} has unsupported type {source_type!r}"
            )
        status = (row.get("Status") or "").strip()
        if status not in {"Complete", "Issued"}:
            raise ValueError(
                f"Venmo transaction {external_id} has non-final status {status!r}"
            )
        note = (row.get("Note") or "").strip()
        sender = (row.get("From") or "").strip()
        recipient = (row.get("To") or "").strip()
        funding_source = (row.get("Funding Source") or "").strip()
        destination = (row.get("Destination") or "").strip()
        affects_cash = bool(
            destination == "Venmo balance"
            or funding_source == "Venmo balance"
            or transaction_type == "transfer"
        )
        description_parts = [source_type]
        if sender or recipient:
            description_parts.append(f"{sender or 'Venmo'} to {recipient or 'Venmo'}")
        if note:
            description_parts.append(note)
        details = {
            "source_status": status,
            "from": sender or None,
            "to": recipient or None,
            "note": note or None,
            "tip": decimal_text(parse_decimal(row.get("Amount (tip)"))),
            "tax": decimal_text(parse_decimal(row.get("Amount (tax)"))),
            "fee": decimal_text(parse_decimal(row.get("Amount (fee)"))),
            "tax_rate": (row.get("Tax Rate") or "").strip() or None,
            "tax_exempt": (row.get("Tax Exempt") or "").strip() or None,
            "funding_source": funding_source or None,
            "destination": destination or None,
            "terminal_location": (row.get("Terminal Location") or "").strip() or None,
            "affects_venmo_cash_balance": affects_cash,
        }
        quantity = None
        symbol = None
        if transaction_type == "crypto_send" and source_type == "Bitcoin Send":
            bitcoin = crypto_summary.get("Bitcoin")
            if bitcoin:
                quantity = abs(bitcoin["closing"] - bitcoin["opening"])
                symbol = "BTC"
                details.update(
                    {
                        "crypto_opening_quantity": decimal_text(
                            bitcoin["opening"]
                        ),
                        "crypto_closing_quantity": decimal_text(
                            bitcoin["closing"]
                        ),
                        "crypto_quantity_source": (
                            "Cryptocurrency summary Available beginning/ending"
                        ),
                    }
                )
        transactions.append(
            make_transaction(
                statement_id=statement_id,
                section=section,
                institution="Venmo",
                sequence=len(transactions) + 1,
                transaction_date=iso(transaction_date),
                description=" · ".join(description_parts),
                amount=amount,
                source_page=1,
                source_line_start=header_index + record_number + 2,
                source_line_end=header_index + record_number + 2,
                raw_text=json.dumps(row, ensure_ascii=False, sort_keys=True),
                transaction_type=transaction_type,
                fee=parse_decimal(row.get("Amount (fee)")),
                quantity=quantity,
                symbol=symbol,
                external_id=external_id,
                notes=json.dumps(details, ensure_ascii=False, sort_keys=True),
            )
        )
    audit = {
        "schema_version": SCHEMA_VERSION,
        "pages": [],
        "unparsed_money_lines": [],
        "ignored_money_lines": [],
        "warnings": [],
        "visual_review_notes": [],
    }
    return "Venmo", [section], transactions, audit


def write_outputs(
    source: Path,
    output_dir: Path,
    source_hash: str,
    statement_id: str,
    institution: str,
    sections: list[Section],
    transactions: list[dict[str, Any]],
    audit: dict[str, Any],
    visual_review: dict[str, Any] | None,
) -> tuple[Path, dict[str, Any]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    reconciliation = reconcile_sections(sections, transactions)
    blocked_reconciliation = any(item["status"] == "fail" for item in reconciliation)
    blocked_coverage = bool(audit["unparsed_money_lines"])
    visual_review_errors = validate_visual_review(
        visual_review,
        source_hash=source_hash,
        pages=audit.get("pages", []),
        sections=sections,
        transactions=transactions,
        warnings=audit["warnings"],
    )
    state = (
        "blocked"
        if blocked_reconciliation or blocked_coverage or visual_review_errors
        else "ready_for_review"
    )
    clean_statements = build_clean_statements(
        sections,
        transactions,
        visual_review,
    )
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "parser_version": PARSER_VERSION,
        "statement_id": statement_id,
        "source_basename": source.name,
        "source_sha256": source_hash,
        "page_count": len(audit.get("pages", [])),
        "detected_institution": institution,
        "transaction_count": len(transactions),
        "sections": reconciliation,
        "warnings": audit["warnings"],
        "visual_review": visual_review,
        "visual_review_errors": visual_review_errors,
        "unparsed_money_line_count": len(audit["unparsed_money_lines"]),
        "validation_state": state,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    bundle = {
        "schema_version": SCHEMA_VERSION,
        "manifest": manifest,
        "statements": clean_statements,
        "transactions": transactions,
        "unparsed_money_lines": audit["unparsed_money_lines"],
    }
    stem = source.stem
    csv_path = output_dir / f"{stem}.transactions.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for transaction in transactions:
            writer.writerow({key: "" if transaction.get(key) is None else transaction.get(key) for key in CSV_FIELDS})
    (output_dir / f"{stem}.manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (output_dir / f"{stem}.audit.json").write_text(
        json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    bundle_path = output_dir / f"{stem}.bundle.json"
    bundle_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    return bundle_path, manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path(".private/imports"))
    parser.add_argument(
        "--visual-review",
        type=Path,
        help="Private JSON record created after visually inspecting every source page",
    )
    parser.add_argument(
        "--verified-transcription",
        type=Path,
        help=(
            "Private, source-hash-bound visual transcription used only when the "
            "PDF's embedded text cannot represent the visible statement exactly"
        ),
    )
    args = parser.parse_args()
    source = args.source.expanduser().resolve()
    if not source.is_file():
        parser.error(f"source not found: {source}")
    source_hash = sha256_bytes(source)
    statement_id = short_id("stmt", source_hash)
    visual_review = (
        json.loads(args.visual_review.read_text(encoding="utf-8"))
        if args.visual_review
        else None
    )
    if source.suffix.lower() == ".pdf":
        pages = extract_pdf_pages(source)
        all_text = "\n".join(page.text for page in pages)
        institution = detect_institution(all_text)
        parsers = {
            "Apple Card": parse_apple,
            "Apple Savings": parse_apple_savings,
            "Banamex": parse_banamex,
            "BBVA": parse_bbva,
            "Wise": parse_wise,
            "Nu": parse_nu,
            "Cash App Investing": parse_cash_app_investing,
            "Cash App Savings": parse_cash_app,
            "Cash App": parse_cash_app,
            "Capital One": parse_capital_one,
            "PayPal": parse_paypal,
            "Robinhood Crypto": parse_robinhood_crypto,
            "Robinhood": parse_robinhood,
            "Unknown": parse_generic,
        }
        sections, transactions, parsed, warnings = parsers[institution](pages, statement_id)
        if args.verified_transcription:
            transcription = json.loads(
                args.verified_transcription.read_text(encoding="utf-8")
            )
            (
                institution,
                sections,
                transactions,
                parsed,
                warnings,
            ) = parse_verified_transcription(
                transcription,
                source_hash=source_hash,
                detected_institution=institution,
                statement_id=statement_id,
                pages=pages,
            )
        if any(not page.text.strip() for page in pages):
            warnings.append("One or more pages are image-only or yielded no text")
        audit = build_audit(pages, parsed, warnings)
    elif source.suffix.lower() in {".csv", ".tsv"}:
        institution, sections, transactions, audit = parse_csv_source(
            source, statement_id
        )
    else:
        parser.error("supported sources are PDF, CSV, and TSV")
    bundle_path, manifest = write_outputs(
        source,
        args.output_dir,
        source_hash,
        statement_id,
        institution,
        sections,
        transactions,
        audit,
        visual_review,
    )
    print(json.dumps({"bundle": str(bundle_path), "manifest": manifest}, indent=2))
    return 0 if manifest["validation_state"] != "blocked" else 2


if __name__ == "__main__":
    sys.exit(main())
