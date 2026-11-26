#!/usr/bin/env python3

"""
REFERENCE DATA FOR THE FINANCIAL CALCULATOR
===========================================

Keeps data/finance_rules.json up to date from official sources, so the
Financial Calculator always uses the current Singapore rules.

  CPF contribution rates      data.gov.sg (CPF Board open data)
  CPF allocation rates        data.gov.sg
  CPF Ordinary Wage ceiling   data.gov.sg
  Full Retirement Sum         data.gov.sg (includes announced future years)
  CPF OA / SMRA interest and  cpf.gov.sg "How are CPF interest rates
  HDB loan rate (quarterly)   determined?" (rendered in Chromium)
  Basic Healthcare Sum        cpf.gov.sg "What is the Basic Healthcare Sum?"
  CPF LIFE payout estimates   cpf.gov.sg "How much CPF payouts can I get every month?"
  Buyer's Stamp Duty bands    iras.gov.sg Buyer's Stamp Duty page

Property-loan limits (TDSR 55%, MSR 30%, the 4% stress-test rate, HDB's
3% floor, LTV 75% / 55%) change only with government cooling measures and
are not published in a machine-readable form, so they are kept in the
file as reviewed values (property.reviewed).

Every value read is checked against sensible ranges. If a source can't
be read or looks wrong, the previous value is kept and the problem is
recorded in "status" (and shown as a warning in the GitHub run). The
script always exits 0 so it never breaks the workflow.

The file is rewritten only when a value changes, or once a week to
record that the sources were checked.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "finance_rules.json"

DATA_GOV = "https://data.gov.sg/api/action/datastore_search"
DATASETS = {
    "contribution": "d_98ffa142ae0dec40391f78f81d26aca9",
    "allocation": "d_97ec9a2ce15cbf253128e48779a3fba0",
    "owCeiling": "d_fcf9b47a2df0c9183875bbfb1c370077",
    "frs": "d_b212dff55c98a4c0b3d3d850bf744ad7",
}
CPF_INTEREST_URL = "https://www.cpf.gov.sg/service/article/how-are-cpf-interest-rates-determined"
CPF_BHS_URL = "https://www.cpf.gov.sg/service/article/what-is-the-basic-healthcare-sum"
CPF_PAYOUT_URL = "https://www.cpf.gov.sg/service/article/how-much-cpf-payouts-can-i-get-every-month"
IRAS_BSD_URL = "https://www.iras.gov.sg/taxes/stamp-duty/for-property/buying-or-acquiring-property/buyer's-stamp-duty-(bsd)"
IRAS_TAX_URL = "https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/tax-residency-and-tax-rates/individual-income-tax-rates"
IRAS_REBATE_URL = "https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/tax-reliefs-rebates-and-deductions/tax-reliefs/personal-income-tax-rebate"
MOM_RETIREMENT_URL = "https://www.mom.gov.sg/employment-practices/retirement"
IRAS_SRS_URL = "https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/special-tax-schemes/srs-contributions"

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
RECHECK_DAYS = 7

# Starting values (November 2026); used only if the file doesn't exist yet
DEFAULTS: dict[str, Any] = {
    "cpf": {
        "interest": {"period": "1 October 2026 to 31 December 2026", "oa": 2.5, "smra": 4.0, "hdbLoan": 2.6},
        "extraInterest": {"below55": {"rate": 1.0, "cap": 60000, "oaCap": 20000}},
        "contribution": {"effective": "2026-01", "bands": [
            {"label": "35 years & below", "maxAge": 35, "employer": 17, "employee": 20},
            {"label": "Above 35 - 45 years", "maxAge": 45, "employer": 17, "employee": 20},
            {"label": "Above 45 - 50 years", "maxAge": 50, "employer": 17, "employee": 20},
            {"label": "Above 50 - 55 years", "maxAge": 55, "employer": 17, "employee": 20},
            {"label": "Above 55 - 60 years", "maxAge": 60, "employer": 16, "employee": 18},
            {"label": "Above 60 - 65 years", "maxAge": 65, "employer": 12.5, "employee": 12.5},
            {"label": "Above 65 - 70 years", "maxAge": 70, "employer": 9, "employee": 7.5},
            {"label": "Above 70 years", "maxAge": 999, "employer": 7.5, "employee": 5},
        ]},
        "allocation": {"effective": "2026-01", "bands": [
            {"label": "35 years & below", "maxAge": 35, "oa": 0.6217, "sa": 0.1621, "ma": 0.2162},
            {"label": "Above 35 - 45 years", "maxAge": 45, "oa": 0.5677, "sa": 0.1891, "ma": 0.2432},
            {"label": "Above 45 - 50 years", "maxAge": 50, "oa": 0.5136, "sa": 0.2162, "ma": 0.2702},
            {"label": "Above 50 - 55 years", "maxAge": 55, "oa": 0.4055, "sa": 0.3108, "ma": 0.2837},
            {"label": "Above 55 - 60 years", "maxAge": 60, "oa": 0.3530, "sa": 0.3382, "ma": 0.3088},
            {"label": "Above 60 - 65 years", "maxAge": 65, "oa": 0.1400, "sa": 0.4400, "ma": 0.4200},
            {"label": "Above 65 - 70 years", "maxAge": 70, "oa": 0.0607, "sa": 0.3030, "ma": 0.6363},
            {"label": "Above 70 years", "maxAge": 999, "oa": 0.0800, "sa": 0.0800, "ma": 0.8400},
        ]},
        "owCeiling": {"effective": "2026-01", "value": 8000},
        "annualCeiling": 102000,
        "frsByYear": {"2025": 213000, "2026": 220400, "2027": 228200},
        "frsGrowth": 0.035,
        "bhs": {"year": 2026, "value": 79000, "growth": 0.04},
        # CPF LIFE Standard Plan: savings in the RA at 55 -> monthly payout from 65 / 70
        "lifePayouts": {"cohortYear": 2026, "points": [
            [50000, 490, 670], [110200, 950, 1280], [150000, 1250, 1670],
            [220400, 1780, 2380], [300000, 2380, 3170], [440800, 3440, 4580]]},
    },
    "property": {
        "tdsr": 0.55, "msr": 0.30, "bankStress": 4.0, "hdbFloor": 3.0, "variableHaircut": 0.70,
        "ltv": 0.75, "ltvLong": 0.55, "minCash": 0.05, "minCashLong": 0.10,
        "reviewed": "2026-11-25",
        "bsd": {"effective": "15 Feb 2023", "bands": [[180000, 0.01], [180000, 0.02], [640000, 0.03], [500000, 0.04], [1500000, 0.05], [None, 0.06]]},
    },
    "protection": {"lifeMultiple": 9, "ciMultiple": 4, "emergencyMonths": [3, 6]},
    # Resident income tax (IRAS). Bands: [size of band, rate]; the last band has no upper limit.
    "tax": {
        "fromYA": "2024",
        "bands": [[20000, 0], [10000, 0.02], [10000, 0.035], [40000, 0.07], [40000, 0.115], [40000, 0.15], [40000, 0.18],
                  [40000, 0.19], [40000, 0.195], [40000, 0.20], [180000, 0.22], [500000, 0.23], [None, 0.24]],
        "rebates": {"2024": [0.5, 200], "2025": [0.6, 200]},
        # Reviewed by hand (rarely change): overall relief cap, earned income relief by age, CPF cash top-up relief
        "reliefCap": 80000, "earnedIncome": [[55, 1000], [60, 6000], [999, 8000]], "topUpSelf": 8000, "topUpFamily": 8000,
    },
    "srs": {"capLocal": 15300, "capForeigner": 35700, "taxable": 0.5, "penalty": 0.05, "ageBefore": 63, "ageAfter": 64, "years": 10,
            # Statutory retirement age by date of first contribution (penalty-free withdrawal age); add a row when it next rises
            "agePeriods": [{"from": "", "age": 62}, {"from": "2022-07-01", "age": 63}, {"from": "2026-07-01", "age": 64},
                           {"from": "2029-01-01", "age": 65}]},
    "sources": {
        "taxRates": IRAS_TAX_URL,
        "taxRebate": IRAS_REBATE_URL,
        "srs": IRAS_SRS_URL,
        "retirementAge": MOM_RETIREMENT_URL,
        "cpfOpenData": "https://data.gov.sg/collections/40/view",
        "frs": "https://data.gov.sg/datasets/d_b212dff55c98a4c0b3d3d850bf744ad7/view",
        "cpfInterest": CPF_INTEREST_URL,
        "bhs": CPF_BHS_URL,
        "lifePayouts": CPF_PAYOUT_URL,
        "bsd": IRAS_BSD_URL,
        "property": "https://www.mas.gov.sg/regulation/explainers/new-private-property-measures",
    },
}


def now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def warn(message: str) -> None:
    print(f"::warning::{message}")


def number(text: str) -> float:
    return float(str(text).replace(",", "").replace("$", "").replace("%", "").strip())


def max_age(label: str) -> int:
    """'Above 35 - 45 years' -> 45, '35 years & below' -> 35, 'Above 70 years' -> 999"""
    numbers = [int(n) for n in re.findall(r"\d+", label)]
    if "below" in label.lower():
        return numbers[0]
    if len(numbers) >= 2:
        return numbers[1]
    return 999


def effective_key(text: str) -> str:
    """'2026-01' or '1/1/2026' -> sortable 'YYYY-MM'"""
    text = text.strip()
    if re.fullmatch(r"\d{4}-\d{2}", text):
        return text
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", text)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}"
    return text


# ------------------------------------------------------------
# data.gov.sg
# ------------------------------------------------------------

def dataset(resource_id: str) -> list[dict]:
    records: list[dict] = []
    offset = 0
    while True:
        response = requests.get(DATA_GOV, params={"resource_id": resource_id, "limit": 1000, "offset": offset},
                                headers={"User-Agent": USER_AGENT}, timeout=60)
        response.raise_for_status()
        result = response.json()["result"]
        records.extend(result["records"])
        if len(records) >= int(result["total"]) or not result["records"]:
            return records
        offset += 1000


def read_contribution() -> dict:
    rows = dataset(DATASETS["contribution"])
    latest = max(effective_key(r["effective_from"]) for r in rows)
    bands: dict[str, dict] = {}
    for r in rows:
        if effective_key(r["effective_from"]) != latest:
            continue
        band = bands.setdefault(r["age_grp"], {"label": r["age_grp"], "maxAge": max_age(r["age_grp"])})
        band[r["contributing_party"].strip().lower()] = number(r["contribution_rate"])
    result = sorted(bands.values(), key=lambda b: b["maxAge"])
    for b in result:
        total = b.get("employer", 0) + b.get("employee", 0)
        if not (5 <= total <= 45):
            raise ValueError(f"unexpected contribution total {total} for {b['label']}")
    if len(result) < 6:
        raise ValueError("too few age bands")
    return {"effective": latest, "bands": result}


def read_allocation() -> dict:
    rows = dataset(DATASETS["allocation"])
    latest = max(effective_key(r["effective_from"]) for r in rows)
    bands: dict[str, dict] = {}
    for r in rows:
        if effective_key(r["effective_from"]) != latest:
            continue
        band = bands.setdefault(r["age_grp"], {"label": r["age_grp"], "maxAge": max_age(r["age_grp"])})
        kind = r["account_type"].strip().lower()
        key = "oa" if kind.startswith("ordinary") else "ma" if kind.startswith("medi") else "sa"
        band[key] = number(r["allocation_rate"])
    result = sorted(bands.values(), key=lambda b: b["maxAge"])
    for b in result:
        total = b.get("oa", 0) + b.get("sa", 0) + b.get("ma", 0)
        if abs(total - 1) > 0.01:
            raise ValueError(f"allocation for {b['label']} adds up to {total}")
    if len(result) < 6:
        raise ValueError("too few age bands")
    return {"effective": latest, "bands": result}


def read_ow_ceiling() -> dict:
    rows = dataset(DATASETS["owCeiling"])
    latest = max(rows, key=lambda r: effective_key(r["effective_from"]))
    value = number(latest["ordinary_wage_ceiling"])
    if not (5000 <= value <= 20000):
        raise ValueError(f"unexpected OW ceiling {value}")
    return {"effective": effective_key(latest["effective_from"]), "value": value}


def read_frs() -> dict:
    rows = dataset(DATASETS["frs"])
    by_year: dict[str, float] = {}
    for r in rows:
        year = effective_key(r["effective_from"])[:4]
        value = number(r["full_retirement_sum"])
        if not (50000 <= value <= 1000000):
            raise ValueError(f"unexpected FRS {value}")
        by_year[year] = value      # later rows in a year (1 Jan) win
    if not by_year:
        raise ValueError("no FRS rows")
    return dict(sorted(by_year.items()))


# ------------------------------------------------------------
# Pages rendered in Chromium (cpf.gov.sg builds its pages in the browser)
# ------------------------------------------------------------

def page_texts(urls: dict[str, str]) -> dict[str, str | Exception]:
    from playwright.sync_api import sync_playwright

    texts: dict[str, str | Exception] = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(user_agent=USER_AGENT, locale="en-SG")
        page = context.new_page()
        for key, url in urls.items():
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                for _ in range(30):
                    text = page.inner_text("body")
                    if len(text) > 1500 and ("%" in text or "$" in text):
                        break
                    page.wait_for_timeout(1000)
                page.wait_for_timeout(1500)
                texts[key] = page.inner_text("body")
            except Exception as error:   # noqa: BLE001
                texts[key] = error
        browser.close()
    return texts


def parse_interest(text: str) -> dict:
    period = re.search(r"Computation of CPF OA Interest Rate and HDB Mortgage Rate for ([^\n]+)", text)
    oa = re.search(r"^CPF OA interest rate for [^\t\n]*\t\s*([\d.]+)%", text, re.M)
    hdb = re.search(r"^HDB mortgage rate for [^\t\n]*\t\s*([\d.]+)%", text, re.M)
    smra = re.search(r"^CPF SMRA interest rate for [^\t\n]*\t\s*([\d.]+)%", text, re.M)
    if not (oa and smra and hdb):
        raise ValueError("rates not found on the page")
    values = {"oa": float(oa.group(1)), "smra": float(smra.group(1)), "hdbLoan": float(hdb.group(1))}
    if not (2 <= values["oa"] <= 8 and 3 <= values["smra"] <= 9 and 1 <= values["hdbLoan"] <= 9):
        raise ValueError(f"unexpected rates {values}")
    return {"period": period.group(1).strip() if period else "", **values}


def parse_bhs(text: str) -> dict:
    m = re.search(r"below age 65 in (\d{4})\s*\n\s*The prevailing BHS is \$([\d,]+)", text)
    if not m:
        raise ValueError("prevailing BHS not found")
    year, value = int(m.group(1)), number(m.group(2))
    if not (40000 <= value <= 300000):
        raise ValueError(f"unexpected BHS {value}")
    # Cohort table: "... 2026 ... $79,000" rows give the recent yearly growth
    cohort = [(int(y), number(v)) for y, v in re.findall(r"\n(20\d\d)\s*\n\s*\t?\s*\n?\s*\$([\d,]+)", text)]
    cohort = sorted({y: v for y, v in cohort}.items())
    growth = 0.04
    if len(cohort) >= 4:
        (y0, v0), (y1, v1) = cohort[-5] if len(cohort) >= 5 else cohort[0], cohort[-1]
        if y1 > y0 and v0 > 0:
            growth = round((v1 / v0) ** (1 / (y1 - y0)) - 1, 4)
    return {"year": year, "value": value, "growth": growth}


def parse_payouts(text: str) -> dict:
    """CPF LIFE table: '$110,200 (Basic Retirement Sum for members turning 55 in 2026)  $170,100  $950  $1,280'"""
    points = []
    for ra55, _ra65, from65, from70 in re.findall(
            r"^\$([\d,]+)(?: \([^)\n]*\))?\s*\t\s*\$([\d,]+)\s*\t\s*\$([\d,]+)\s*\t\s*\$([\d,]+)\s*$", text, re.M):
        points.append([number(ra55), number(from65), number(from70)])
    points.sort()
    cohort = re.search(r"turning 55 in (\d{4})", text)
    if len(points) < 4:
        raise ValueError("payout table not found")
    for a, b in zip(points, points[1:]):
        if not (b[1] >= a[1] and b[2] >= a[2]):
            raise ValueError("payouts don't rise with savings")
    if not all(100 <= p[1] <= 20000 and p[2] >= p[1] for p in points):
        raise ValueError("unexpected payout amounts")
    return {"cohortYear": int(cohort.group(1)) if cohort else datetime.now().year, "points": points}


def parse_bsd(text: str) -> dict:
    start = text.find("On or after")
    end = text.find("BSD is rounded down", start)
    if start < 0 or end < 0:
        raise ValueError("BSD table not found")
    block = text[start:end]
    effective = re.match(r"On or after ([^\n]+)", block)
    bands: list[list] = []
    for size, rate in re.findall(r"(?:First|Next) \$([\d,]+)\s*\t\s*([\d.]+)%", block):
        bands.append([number(size), float(rate) / 100])
    remaining = re.search(r"Remaining amount\s*\t\s*([\d.]+)%", block)
    if not bands or not remaining or bands[0] != [180000.0, 0.01]:
        raise ValueError("BSD bands look wrong")
    bands.append([None, float(remaining.group(1)) / 100])
    return {"effective": effective.group(1).strip() if effective else "", "bands": bands}


def parse_tax_bands(text: str) -> dict:
    """IRAS 'From YA 2024 onwards' table: 'First $20,000 / Next $10,000  0 / 2 ...  In excess of $1,000,000  - 24'"""
    start = re.search(r"From YA (\d{4}) onwards", text)
    if not start:
        raise ValueError("resident tax table not found")
    end = text.find("Personal Income Tax Rebate", start.end())
    block = text[start.end(): end if end > 0 else start.end() + 4000]
    first = re.search(r"First \$([\d,]+)", block)
    bands: list[list] = [[number(first.group(1)), 0.0]] if first else []
    for size, rate in re.findall(r"Next \$([\d,]+)\s*(?:0|-)\s*([\d.]+)", block):
        bands.append([number(size), round(float(rate) / 100, 5)])
    top = re.search(r"In excess of \$([\d,]+)\s*-\s*([\d.]+)", block)
    if not top:
        raise ValueError("top band not found")
    bands.append([None, round(float(top.group(2)) / 100, 5)])
    rates = [b[1] for b in bands]
    total = sum(b[0] for b in bands[:-1])
    if (len(bands) < 8 or bands[0] != [20000.0, 0.0] or rates != sorted(rates) or not 0.15 <= rates[-1] <= 0.35
            or abs(total - number(top.group(1))) > 0.5):
        raise ValueError(f"tax bands look wrong: {bands}")
    return {"fromYA": start.group(1), "bands": bands}


def parse_rebates(text: str) -> dict:
    """'2025  60% of tax payable, up to $200'"""
    found = re.findall(r"\b(20\d\d)\s+(\d+(?:\.\d+)?)% of tax payable,? (?:up to|capped at) \$([\d,]+)", text)
    if not found:
        raise ValueError("rebate table not found")
    rebates = {ya: [float(p) / 100, number(cap)] for ya, p, cap in found}
    if any(not 0 < v[0] <= 1 or not 0 < v[1] <= 5000 for v in rebates.values()):
        raise ValueError(f"rebates look wrong: {rebates}")
    return rebates


def parse_srs(text: str) -> dict:
    """'Yearly maximum SRS contributions ... $15,300  $35,700'"""
    match = re.search(r"Yearly maximum SRS contributions.{0,200}?\$([\d,]+)\s+\$([\d,]+)", text, re.S)
    if not match:
        raise ValueError("SRS caps not found")
    local, foreigner = number(match.group(1)), number(match.group(2))
    if not (5000 <= local < foreigner <= 100000):
        raise ValueError(f"SRS caps look wrong: {local}, {foreigner}")
    return {"capLocal": local, "capForeigner": foreigner}


def parse_retirement_ages(text: str, periods: list[dict]) -> list[dict]:
    """MOM retirement page: 'from 1 July 2026, the minimum retirement age is 64 years' and
    'The retirement age will be raised to 65 years from 1 January 2029'. New dates are added to the
    SRS withdrawal-age periods; existing ones are never removed."""
    def iso(day: str) -> str:
        return datetime.strptime(day.strip(), "%d %B %Y").strftime("%Y-%m-%d")
    found: list[tuple[str, int]] = []
    for day, age in re.findall(r"from (\d{1,2} [A-Z][a-z]+ \d{4}),? the minimum retirement age is (\d{2}) years", text):
        found.append((iso(day), int(age)))
    for age, day in re.findall(r"retirement age will be raised to (\d{2}) years from (\d{1,2} [A-Z][a-z]+ \d{4})", text):
        found.append((iso(day), int(age)))
    if not found:
        raise ValueError("retirement age sentences not found")
    out = [dict(p) for p in periods]
    for day, age in found:
        if not (60 <= age <= 75 and "2022-01-01" <= day <= "2045-12-31"):
            raise ValueError(f"retirement age looks wrong: {age} from {day}")
        same = next((p for p in out if p["from"] == day), None)
        if same:
            same["age"] = age
        else:
            same_age = next((p for p in out if p["age"] == age), None)
            if not same_age:
                out.append({"from": day, "age": age})
            elif same_age["from"] > datetime.now(timezone.utc).strftime("%Y-%m-%d"):
                same_age["from"] = day            # an announced date that was moved
    out.sort(key=lambda p: p["from"])
    ages = [p["age"] for p in out]
    if ages != sorted(ages) or len(set(ages)) != len(ages):
        raise ValueError(f"retirement ages out of order: {out}")
    return out


# ------------------------------------------------------------

def main() -> int:
    previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    rules: dict[str, Any] = json.loads(json.dumps(previous or DEFAULTS))
    for key, value in DEFAULTS.items():            # new keys added in later versions
        rules.setdefault(key, value)
    rules["cpf"] = {**DEFAULTS["cpf"], **rules.get("cpf", {})}
    for key in ("tax", "srs", "sources"):
        rules[key] = {**DEFAULTS[key], **rules.get(key, {})}
    status: dict[str, Any] = {}
    checked = now_utc()

    def attempt(name: str, fn, apply) -> None:
        try:
            value = fn()
            apply(value)
            status[name] = {"ok": True, "checkedUtc": checked}
            print(f"  ok      {name}")
        except Exception as error:   # noqa: BLE001
            old = (previous.get("status") or {}).get(name, {})
            status[name] = {"ok": False, "checkedUtc": checked, "lastGoodUtc": old.get("lastGoodUtc") or old.get("checkedUtc"), "message": str(error)[:300]}
            warn(f"{name}: kept the previous value ({error})")

    print("Financial calculator reference data")
    cpf = rules["cpf"]
    attempt("cpfContribution", read_contribution, lambda v: cpf.__setitem__("contribution", v))
    attempt("cpfAllocation", read_allocation, lambda v: cpf.__setitem__("allocation", v))
    attempt("cpfOwCeiling", read_ow_ceiling, lambda v: cpf.__setitem__("owCeiling", v))
    attempt("frs", read_frs, lambda v: cpf.__setitem__("frsByYear", v))

    try:
        texts = page_texts({"interest": CPF_INTEREST_URL, "bhs": CPF_BHS_URL, "payouts": CPF_PAYOUT_URL, "bsd": IRAS_BSD_URL,
                            "tax": IRAS_TAX_URL, "rebate": IRAS_REBATE_URL, "srs": IRAS_SRS_URL, "retirement": MOM_RETIREMENT_URL})
    except Exception as error:   # noqa: BLE001
        texts = {k: error for k in ("interest", "bhs", "payouts", "bsd", "tax", "rebate", "srs", "retirement")}

    def from_text(key: str, parser):
        def run():
            text = texts.get(key)
            if isinstance(text, Exception) or text is None:
                raise RuntimeError(f"page did not open: {text}")
            return parser(text)
        return run

    attempt("cpfInterest", from_text("interest", parse_interest), lambda v: cpf.__setitem__("interest", v))
    attempt("bhs", from_text("bhs", parse_bhs), lambda v: cpf.__setitem__("bhs", v))
    attempt("lifePayouts", from_text("payouts", parse_payouts), lambda v: cpf.__setitem__("lifePayouts", v))
    attempt("bsd", from_text("bsd", parse_bsd), lambda v: rules["property"].__setitem__("bsd", v))
    attempt("taxRates", from_text("tax", parse_tax_bands), lambda v: rules["tax"].update(v))
    attempt("taxRebate", from_text("rebate", parse_rebates), lambda v: rules["tax"].__setitem__("rebates", v))
    attempt("srsCaps", from_text("srs", parse_srs), lambda v: rules["srs"].update(v))
    attempt("retirementAge", from_text("retirement", lambda text: parse_retirement_ages(text, rules["srs"]["agePeriods"])),
            lambda v: rules["srs"].__setitem__("agePeriods", v))

    for name, entry in status.items():
        if entry["ok"]:
            entry["lastGoodUtc"] = checked

    # Only rewrite when a value changed, or to record a check once a week
    def values_only(doc: dict) -> dict:
        return {k: v for k, v in doc.items() if k not in ("status", "checkedUtc", "updatedUtc")}

    changed = values_only(rules) != values_only(previous)
    last_check = previous.get("checkedUtc")
    stale = True
    if last_check:
        try:
            stale = datetime.now(timezone.utc) - datetime.fromisoformat(last_check) > timedelta(days=RECHECK_DAYS)
        except ValueError:
            stale = True
    problems_changed = {k: v.get("ok") for k, v in status.items()} != {k: v.get("ok") for k, v in (previous.get("status") or {}).items()}

    if changed or stale or problems_changed or not OUT.exists():
        rules["checkedUtc"] = checked
        rules["updatedUtc"] = checked if changed or not previous else previous.get("updatedUtc", checked)
        rules["status"] = status
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(rules, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {OUT.relative_to(ROOT)} ({'values changed' if changed else 'recorded check'}).")
    else:
        print("No change.")

    failed = [k for k, v in status.items() if not v["ok"]]
    print(f"{len(status) - len(failed)} of {len(status)} sources read" + (f"; kept previous values for: {', '.join(failed)}" if failed else "."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
