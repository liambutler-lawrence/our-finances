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
from dataclasses import asdict, dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = "1.1.0"
PARSER_VERSION = "1.2.0"
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
    if "apple card" in lowered and "goldman sachs" in lowered:
        return "Apple Card"
    if re.search(r"\bwise\b", lowered) and (
        "extracto en" in lowered or "wise payments" in lowered
    ):
        return "Wise"
    if "cuenta nu" in lowered or "tarjeta de crédito nu" in lowered:
        return "Nu"
    if "cash app" in lowered and "account statement" in lowered:
        return "Cash App"
    if "capital one 360" in lowered or "capitalone.com" in lowered:
        return "Capital One"
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
    return "Needs review", "0.25", "unknown"


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
            if stripped in {"Payments", "Transactions", "Interest Charges", "Fees"}:
                section_type = stripped
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


def parse_wise(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    currency_match = re.search(r"Extracto en\s+([A-Z]{3})", text)
    currency = currency_match.group(1) if currency_match else "USD"
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
        period_start, period_end = find_period(text)
    closing_match = re.search(
        rf"{currency}\s+el\s+.+?\s+([\d.,]+)\s+{currency}", text, re.IGNORECASE
    )
    account_match = re.search(r"Número de cuenta\s+Número de ruta\s*\n.*?\n.*?(\d{6,})", text)
    account_number = account_match.group(1) if account_match else ""
    section = Section(
        short_id("acct", statement_id, "wise", currency, account_number[-4:]),
        f"Wise {currency}",
        account_number[-4:] or None,
        "checking",
        currency,
        period_start,
        period_end,
        None,
        decimal_text(parse_decimal(closing_match.group(1))) if closing_match else None,
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    sequence = 0
    for page in pages:
        for start, end, group in nonempty_groups(page):
            joined = "\n".join(group)
            tx_date = parse_spanish_date(joined)
            if not tx_date or "Resumen de comisiones" in joined:
                continue
            first = group[0]
            values = [parse_decimal(match.group(0)) for match in MONEY_RE.finditer(first)]
            values = [value for value in values if value is not None]
            if len(values) < 2:
                continue
            amount, balance = values[-2], values[-1]
            description = re.split(r"\s{2,}", first.strip())[0]
            external_match = re.search(r"Transacci[oó]n:\s*([^\s|]+)", joined)
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
    period_match = re.search(r"Periodo:\s*del\s*(\d{2})\s+al\s+(\d{2})\s+([a-z]{3})\s+(20\d{2})", text, re.I)
    if period_match:
        month = MONTHS_ES[period_match.group(3).lower()]
        period_start = iso(date(int(period_match.group(4)), month, int(period_match.group(1))))
        period_end = iso(date(int(period_match.group(4)), month, int(period_match.group(2))))
    else:
        period_start, period_end = find_period(text)
    account_match = re.search(r"Cuenta Nu:\s*(\d+)", text)
    opening_match = re.search(r"Saldo inicial\s+\$?([\d,.]+)", text)
    closing_match = re.search(r"Saldo al generar este estado de cuenta\s+\$?([\d,.]+)", text)
    section = Section(
        short_id("acct", statement_id, "nu", account_match.group(1)[-4:] if account_match else ""),
        "Nu account total",
        account_match.group(1)[-4:] if account_match else None,
        "checking",
        "MXN",
        period_start,
        period_end,
        decimal_text(parse_decimal(opening_match.group(1))) if opening_match else None,
        decimal_text(parse_decimal(closing_match.group(1))) if closing_match else None,
    )
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    sequence = 0
    for page in pages:
        if "Detalle de movimientos" not in page.text:
            continue
        index = 0
        while index < len(page.lines):
            stripped = page.lines[index].strip()
            match = re.match(
                r"^(\d{1,2}\s+[A-Za-z]{3}\s+20\d{2})\s+(.*?)\s+([+-]?\$[\d,.]+)$",
                stripped,
                re.IGNORECASE,
            )
            if not match:
                index += 1
                continue
            start = index
            block = [page.lines[index]]
            index += 1
            while index < len(page.lines):
                nxt = page.lines[index].strip()
                if re.match(r"^\d{1,2}\s+[A-Za-z]{3}\s+20\d{2}\b", nxt, re.I):
                    break
                if nxt:
                    block.append(page.lines[index])
                index += 1
            tx_date = parse_spanish_date(match.group(1))
            amount = parse_decimal(match.group(3))
            if tx_date and amount is not None:
                description = match.group(2)
                tx_type = "transfer" if re.search(
                    r"(Transferencia|Cajita|Pago a tu tarjeta)", description, re.I
                ) else "purchase"
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
                        source_line_start=start + 1,
                        source_line_end=start + len(block),
                        raw_text="\n".join(block),
                        transaction_type=tx_type,
                        notes="Nu subaccount movement" if "cajita" in page.text.lower() else None,
                    )
                )
                parsed.update(
                    (page.page, line_number)
                    for line_number in range(start + 1, start + len(block) + 1)
                )
    interest_match = re.search(r"Dinero generado este mes\s+\$?([\d,.]+)", text)
    if interest_match and parse_decimal(interest_match.group(1)):
        page_number = next(
            (page.page for page in pages if "Dinero generado este mes" in page.text), 1
        )
        amount = parse_decimal(interest_match.group(1))
        sequence += 1
        transactions.append(
            make_transaction(
                statement_id=statement_id,
                section=section,
                institution="Nu",
                sequence=sequence,
                transaction_date=period_end,
                description="Dinero generado este mes",
                amount=amount or Decimal("0"),
                source_page=page_number,
                source_line_start=1,
                source_line_end=1,
                raw_text=interest_match.group(0),
                transaction_type="interest",
                notes="Summary-derived interest required for statement reconciliation",
            )
        )
    return [section], transactions, parsed, []


def parse_cash_app(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    text = "\n".join(page.text for page in pages)
    period_match = re.search(r"\b([A-Za-z]+)\s+(20\d{2})\b", text)
    if period_match:
        month = MONTHS_EN[period_match.group(1)[:3].lower()]
        year = int(period_match.group(2))
        period_start = iso(date(year, month, 1))
        dated_lines = [
            parse_short_month_date(match.group(0), year)
            for match in re.finditer(r"\b[A-Za-z]{3}\s+\d{1,2}\b", text)
            if parse_short_month_date(match.group(0), year)
        ]
        last_day = max(dated_lines) if dated_lines else date(
            year,
            month,
            calendar.monthrange(year, month)[1],
        )
        period_end = iso(last_day)
    else:
        year, period_start, period_end = date.today().year, None, None
    opening_match = re.search(r"Balance on [A-Za-z]{3} \d+\s+\$?([\d,.]+)", text)
    closing_matches = re.findall(r"Balance on [A-Za-z]{3} \d+\s+\$?([\d,.]+)", text)
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
        short_id("acct", statement_id, "cash-app"),
        "Cash App account",
        None,
        "cash",
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
            if not re.search(r"[+-]", parts[-1]):
                amount = -abs(amount) if description.lower().startswith("to ") else abs(amount)
            fee = parse_decimal(parts[-2])
            sequence += 1
            transactions.append(
                make_transaction(
                    statement_id=statement_id,
                    section=section,
                    institution="Cash App",
                    sequence=sequence,
                    transaction_date=iso(tx_date),
                    description=description,
                    amount=amount,
                    fee=fee,
                    source_page=page.page,
                    source_line_start=index,
                    source_line_end=index,
                    raw_text=line,
                    transaction_type="transfer" if "transfer" in stripped.lower() else "purchase",
                )
            )
            parsed.add((page.page, index))
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
            tx_type = (
                "interest"
                if "Interest Paid" in description
                else "payment"
                if "APPLECARD" in description
                else "informational"
                if amount == 0
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


def parse_robinhood(
    pages: list[SourcePage], statement_id: str
) -> tuple[list[Section], list[dict[str, Any]], set[tuple[int, int]], list[str]]:
    sections: list[Section] = []
    transactions: list[dict[str, Any]] = []
    parsed: set[tuple[int, int]] = set()
    current: Section | None = None
    sequence = 0
    for page in pages:
        account_match = re.search(r"(?:Individual|Joint|Traditional|Roth).*Account #:(\d+)", page.text)
        period_match = re.search(r"(\d{2}/\d{2}/20\d{2})\s+to\s+(\d{2}/\d{2}/20\d{2})", page.text)
        if account_match and "Account Summary" in page.text:
            start = parse_us_date(period_match.group(1)) if period_match else None
            end = parse_us_date(period_match.group(2)) if period_match else None
            type_match = re.search(r"\b(Individual|Joint|Traditional|Roth)[^\n]*Account #", page.text)
            name = f"Robinhood {type_match.group(1) if type_match else 'Brokerage'}"
            current = Section(
                short_id("acct", statement_id, "robinhood", account_match.group(1)[-4:]),
                name,
                account_match.group(1)[-4:],
                "brokerage",
                "USD",
                iso(start),
                iso(end),
                reconciliation_kind="market_value",
            )
            balance_match = re.search(
                r"Net Account Balance\s+\$?([\d,.]+)\s+\$?([\d,.]+)", page.text
            )
            if balance_match:
                current.opening_balance = decimal_text(parse_decimal(balance_match.group(1)))
                current.closing_balance = decimal_text(parse_decimal(balance_match.group(2)))
            sections.append(current)
            continue
        if current is None or "Account Activity" not in page.text:
            continue
        debit_header = next(
            (line for line in page.lines if "Debit" in line and "Credit" in line), ""
        )
        debit_col = debit_header.find("Debit") if debit_header else -1
        credit_col = debit_header.find("Credit") if debit_header else -1
        for start_line, end_line, group in nonempty_groups(page):
            joined = "\n".join(group)
            tx_date = parse_us_date(joined)
            if not tx_date or joined.startswith("Description"):
                continue
            date_line = next((line for line in group if US_DATE_RE.search(line)), group[-1])
            debit = (
                parse_decimal(date_line[debit_col:credit_col])
                if debit_col >= 0 and credit_col > debit_col
                else None
            )
            credit = parse_decimal(date_line[credit_col:]) if credit_col >= 0 else None
            if debit is None and credit is None:
                values = [parse_decimal(match.group(0)) for match in MONEY_RE.finditer(date_line)]
                values = [value for value in values if value is not None]
                debit = values[-1] if values else None
            amount = credit if credit is not None else -abs(debit or Decimal("0"))
            description = group[0].strip()
            tokens = re.split(r"\s{2,}", date_line.strip())
            symbol = next(
                (token for token in tokens if re.fullmatch(r"[A-Z.]{1,6}", token)),
                None,
            )
            action = next(
                (token for token in tokens if token in {"Buy", "Sell", "COIN", "ACH", "Dividend"}),
                "unknown",
            )
            quantity = next(
                (
                    parse_decimal(token)
                    for token in tokens
                    if re.fullmatch(r"\d+\.\d{3,}", token)
                ),
                None,
            )
            prices = [
                parse_decimal(token)
                for token in tokens
                if token.startswith("$") and parse_decimal(token) is not None
            ]
            unit_price = prices[0] if quantity is not None and prices else None
            tx_type = action.lower() if action in {"Buy", "Sell"} else "transfer"
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
                    transaction_type=tx_type,
                    quantity=quantity,
                    unit_price=unit_price,
                    symbol=symbol,
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


def reconcile_sections(
    sections: list[Section], transactions: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for section in sections:
        activity = sum(
            (
                Decimal(tx["amount"])
                for tx in transactions
                if tx["account_section_id"] == section.account_section_id
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
    return errors


def ignored_money_line(text: str) -> str | None:
    patterns = {
        r"^\s*(Total|TOTAL|All Accounts|Portfolio Value|Total Securities|Net Account Balance)": "statement summary",
        r"(Minimum Payment|Payment Due|YTD|APY|rendimiento|GAT|saldo promedio)": "disclosure or summary",
        r"(Opening Balance|Closing Balance|Saldo inicial|Saldo al generar|Balance on|Previous .*Balance|Your .* Balance|Money In|Money Out)": "balance metadata",
        r"(Comisiones|Resumen de comisiones|fees|Fees)": "fee summary",
        r"(Annual Percentage|percentage yield|interés bruto|impuestos|Daily Cash|Dividends|Capital Gains|Interest Earned|Stock Lending|THIS PERIOD)": "rate or income summary",
        r"^\s*\$[\d,.]+\s+\$[\d,.]+\s*(?:[A-Za-z]{3}\s+\d{1,2},\s+20\d{2})?\s*$": "multi-column balance summary",
        r"(recurring payment|balance of \$[\d,.]+ for|Total interest charged|credit bureaus|Late payments)": "card disclosure or summary",
        r"^\s*[—–-]?\s*\$0\.00\s*$": "zero-value summary",
        r"^\s*(Depósitos|Gastos)\s+[+-]?\$[\d,.]+\s*$": "account activity summary",
        r"(Dinero generado este mes|Disponible 24/7|Congelado|UDIS|Recuerda que las obtendrás desde|teléfono \+\d)": "account disclosure or summary",
        r"(Periodo seleccionado|Mes calendario anterior|Año actual|llámanos al|Wise US Inc\.)": "fee or support disclosure",
        r"^\s*\$[\d,.]+\s+IN ALL ACCOUNTS\s*$": "combined account summary",
        r"^\s*360 .*\$[\d,.]+\s+\$[\d,.]+\s*$": "combined account summary",
        r"^\s*360 .* - \d+\s*$": "account heading",
        r"^\s*\d+(?:\.\d+)?%\s+\$[\d,.]+\s+\d+\s*$": "rate summary",
        r"^\s*(?:\d+(?:\.\d+)?%)\s*$": "portfolio percentage",
        r"\bMargin\b.*\$[\d,.]+.*%": "portfolio holding snapshot",
        r"(Estimated Yield|Brokerage Cash Balance)": "portfolio summary",
        r"(Member of SIPC|net capital of \$|required net capital|debit card transactions.*statement|Visa U\.S\.A\. Inc\..*December 31)": "regulatory disclosure",
        r"\b(?:UTC|GMT)\s*[+-]\d{1,2}:\d{2}\b": "time-zone disclosure",
        r"(Page \d+|Página \d+|\d+\s*/\s*\d+)": "page footer",
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
) -> tuple[list[Section], list[dict[str, Any]], dict[str, Any]]:
    source_text = path.read_text(encoding="utf-8-sig")
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
    return [section], transactions, audit


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
            "Wise": parse_wise,
            "Nu": parse_nu,
            "Cash App": parse_cash_app,
            "Capital One": parse_capital_one,
            "Robinhood": parse_robinhood,
            "Unknown": parse_generic,
        }
        sections, transactions, parsed, warnings = parsers[institution](pages, statement_id)
        if any(not page.text.strip() for page in pages):
            warnings.append("One or more pages are image-only or yielded no text")
        audit = build_audit(pages, parsed, warnings)
    elif source.suffix.lower() in {".csv", ".tsv"}:
        institution = "CSV"
        sections, transactions, audit = parse_csv_source(source, statement_id)
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
