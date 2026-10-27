#!/usr/bin/env python3
"""
VGrat FMS - FETCH BROCHURES (Annex)

Builds data/brochures.json: every product listed on Prudential
Singapore's product pages, with links to its brochures and other
product documents (product highlight sheets, fund booklets, FAQs ...).

How it finds them (public pages only):

  1. Opens the product category pages (Health, Life, Wealth, Legacy
     planning, SRS) and reads the product list each page loads
     (an AEM "productcomparisonsel.model.json" file).
  2. Also picks up product pages linked straight from those pages.
  3. Opens each product page and collects its PDF links.

  4. Keeps only the brochures (English / Chinese) - other documents
     (FAQs, highlight sheets, forms ...) are left out - and downloads
     each brochure into the Brochure/ folder, named
     <product>-EN.pdf / <product>-CN.pdf. The Annex shows them from
     there in a popup.

Every run starts from scratch: the whole Brochure/ folder and the list
are replaced, so withdrawn products and old brochure versions are
removed.

If the site can't be read (blocked, down, layout changed) or most
brochures fail to download, nothing is changed and the run fails (red
in the Actions tab), so a bad run never empties the Annex.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, unquote, urlparse

import requests


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_FILE = ROOT / "data" / "brochures.json"
PDF_DIR = ROOT / "Brochure"           # served by GitHub Pages as /Brochure/...
MAX_PDF_BYTES = 90 * 1024 * 1024      # GitHub's per-file limit is 100 MB
MIN_DOWNLOADED = 0.5                  # share of brochures that must download

BROCHURE_README = """# Brochure

Prudential Singapore product brochures (English and Chinese), shown in
the dashboard's Annex.

This folder is filled by the "Fetch Brochures" GitHub workflow
(scripts/fetch_brochures.py) every 2 weeks. Each run deletes everything
here and downloads the current brochures again, so don't put your own
files in this folder.
"""

BASE = "https://www.prudential.com.sg"

# Category pages to read (the product lists live on the top pages;
# sub pages are read too in case Prudential moves them).
CATEGORY_PAGES = [
    "/en/products/health/",
    "/en/products/health/medical/",
    "/en/products/health/accident/",
    "/en/products/health/critical-illness/",
    "/en/products/life/",
    "/en/products/life/whole-life/",
    "/en/products/life/term-life/",
    "/en/products/life/maternity/",
    "/en/products/life/mortgage/",
    "/en/products/wealth/",
    "/en/products/wealth/savings/",
    "/en/products/wealth/retirement/",
    "/en/products/wealth/investments/",
    "/en/products/wealth/funds/",
    "/en/products/legacy-planning/",
    "/en/products/srs/",
]

GROUP_NAMES = {
    "health": "Health",
    "life": "Life",
    "wealth": "Wealth",
    "legacy-planning": "Legacy Planning",
    "srs": "SRS",
}

GROUP_ORDER = ["Health", "Life", "Wealth", "Legacy Planning", "SRS"]

# Direct product links (not in the product lists) that are only
# navigation / information pages
SKIP_PAGE = re.compile(r"/(explore-more|faq|play-the-right-cards-with-srs)/$", re.I)

MIN_PRODUCTS = 10        # fewer than this = the site layout probably changed
RETRIES = 3
TIMEOUT = 30
PAUSE = 0.6              # seconds between page requests (be polite)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-SG,en;q=0.9",
}

MODEL_RE = re.compile(
    r"/content/prudential-aem-lbu/pacs/en/[^\"'\s<>]*?productcomparison[^\"'\s<>]*?\.model\.json"
)
PRODUCT_HREF_RE = re.compile(r"""href=["'](/en/products/[^"'#?]+/)["']""")

session = requests.Session()
session.headers.update(HEADERS)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def clean(value) -> str:
    return " ".join(unescape(str(value or "")).split())


def strip_tags(value) -> str:
    return clean(re.sub(r"<[^>]+>", " ", str(value or "")))


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def get(url: str, as_json: bool = False):
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            response = session.get(url, timeout=TIMEOUT)
            if response.status_code == 404:
                return None
            response.raise_for_status()
            time.sleep(PAUSE)
            return response.json() if as_json else response.text
        except Exception as error:  # noqa: BLE001
            last = error
            time.sleep(attempt * 2)
    raise RuntimeError(f"{url}: {last}")


def page_path(link: str) -> str:
    path = urlparse(urljoin(BASE, link)).path
    return path if path.endswith("/") else path + "/"


def group_of(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    # /en/products/<group>/...
    key = parts[2] if len(parts) > 2 else ""
    return GROUP_NAMES.get(key, "Other")


# ---------------------------------------------------------------------------
# product page parsing
# ---------------------------------------------------------------------------

class PageParser(HTMLParser):
    """Collects og:title, <title>, <h1> and every <a href="...pdf">."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.og_title = ""
        self.title = ""
        self.h1 = ""
        self.links = []          # [(href, text)]
        self._in_title = False
        self._in_h1 = False
        self._anchor = None      # [href, text parts, aria label]

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta" and (a.get("property") or "").lower() == "og:title":
            self.og_title = clean(a.get("content"))
        elif tag == "title":
            self._in_title = True
        elif tag == "h1" and not self.h1:
            self._in_h1 = True
        elif tag == "a":
            href = a.get("href") or ""
            if ".pdf" in href.lower():
                self._anchor = [href, [], a.get("aria-label") or a.get("title") or ""]

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "h1":
            self._in_h1 = False
        elif tag == "a" and self._anchor:
            href, parts, label = self._anchor
            self.links.append((href, clean(" ".join(parts)) or clean(label)))
            self._anchor = None

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._in_h1:
            self.h1 += data
        if self._anchor:
            self._anchor[1].append(data)


def name_from_file(href: str) -> str:
    stem = unquote(href.rsplit("/", 1)[-1]).rsplit(".", 1)[0]
    stem = re.sub(r"[_\-]+", " ", stem)
    return clean(stem)


def classify(href: str, text: str):
    """-> (kind, label, lang)"""
    t = text.lower()
    f = href.lower().rsplit("/", 1)[-1]

    lang = ""
    if re.search(r"\((ch|cn|chn|chi|chinese)\)", t) or re.search(r"(chinese|[_\-](ch|cn|chn|chi)[_\-.])", f):
        lang = "CN"
    elif re.search(r"\((en|eng|english)\)", t) or re.search(r"(english|[_\-](en|eng)[_\-.])", f):
        lang = "EN"

    if "brochure" in t or "brochure" in f:
        return "brochure", "Brochure", lang or "EN"

    label = re.sub(r"\s*download\s*$", "", text, flags=re.I).strip()
    if not label or label.lower() in {"here", "click here", "download", "this link"}:
        label = name_from_file(href)
    return "document", label, lang


def page_name(parser: PageParser) -> str:
    title = clean(parser.og_title or parser.h1 or parser.title)
    title = re.sub(r"\s*\|\s*Prudential Singapore\s*$", "", title, flags=re.I)
    # "PRUMan - Critical Illness Insurance for Men" -> keep the name part
    name = re.split(r"\s+[–—|]\s+", title)[0]
    if name.upper().startswith("DIRECT"):
        head, _, rest = name.partition(" - ")
        name = head + " - " + re.split(r"\s+-\s+", rest)[0] if rest else name
    else:
        name = re.split(r"\s+-\s+", name)[0]
    return name.strip()


def matches_page(listing_title: str, page_title: str) -> bool:
    """Prudential's list sometimes points a product at another
    product's page; such a listing doesn't match the page title."""
    def first(text):
        words = re.sub(r"^DIRECT\s*-\s*", "", text, flags=re.I).split()
        return re.sub(r"^pru", "", words[0].lower()) if words else ""

    a, b = first(listing_title), first(page_title)
    return bool(a and b) and (a in page_title.lower() or b in listing_title.lower())


def resolve(listings, parser: PageParser):
    """-> (name, description, categories, placements)

    placements: every place Prudential lists the product, in the
    site's own order - [{"group", "category", "order"}]."""
    page_title = page_name(parser)

    # Listings from a product list must match the page (Prudential's
    # list sometimes points a product at another product's page);
    # plain links from a page without a list (e.g. SRS) have no title.
    good = [
        l for l in listings
        if not l["title"] or not page_title or matches_page(l["title"], page_title)
    ]
    titled = [l for l in good if l["title"]]

    name = titled[0]["title"] if titled else (page_title or (listings[0]["title"] if listings else ""))
    description = next((l["description"] for l in good if l["description"]), "")

    placements = []
    seen = set()
    for listing in sorted(good, key=lambda l: l["order"]):
        key = (listing["group"], listing["category"])
        if key in seen:
            continue
        seen.add(key)
        placements.append({
            "group": listing["group"],
            "category": listing["category"],
            "order": list(listing["order"]),
        })

    categories = sorted({p["category"] for p in placements if p["category"] and p["category"] != p["group"]})

    # Every label that applies, no limit: where it's listed + Prudential's tags
    tags = []
    for place in placements:
        tags.append(place["category"] if place["category"] and place["category"] != place["group"] else place["group"])
    for listing in good:
        tags.extend(listing.get("tags") or [])
    tags = list(dict.fromkeys(t for t in tags if t))

    return name, description, categories, placements, tags


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def group_rank(group: str) -> int:
    return GROUP_ORDER.index(group) if group in GROUP_ORDER else 99


def collect_product_list():
    """-> {path: {"listings": [{title, description, group, category, order}]}}

    A product appears once per place Prudential lists it (e.g. a plan
    under both Health > Critical Illness and Life > Whole Life);
    "order" keeps the site's own sorting."""
    products = {}
    models = {}          # model url -> group of the page it came from
    direct = []          # (path, group, position) from pages without a product list
    errors = []

    for category in CATEGORY_PAGES:
        try:
            html = get(BASE + category)
        except Exception as error:  # noqa: BLE001
            errors.append(str(error))
            continue
        if not html:
            continue

        page_models = MODEL_RE.findall(html)
        for model in page_models:
            # ".../pacs/en/products/health/jcr:content/..." -> "/en/products/health/"
            models.setdefault(model, group_of("/en" + model.split("/pacs/en", 1)[-1].split("/jcr:")[0] + "/"))

        position = 0
        for href in PRODUCT_HREF_RE.findall(html):
            path = page_path(href)
            if path in CATEGORY_PAGES or path.count("/") < 5 or SKIP_PAGE.search(path):
                continue
            # Pages with a product list: extra links are kept (no placement
            # of their own); pages without one (SRS): links ARE the list.
            group = None if page_models else group_of(category)
            direct.append((path, group, position))
            position += 1

    for model, group in models.items():
        try:
            data = get(BASE + model, as_json=True) or {}
        except Exception as error:  # noqa: BLE001
            errors.append(str(error))
            continue
        for tab_index, tab in enumerate(data.get("categories") or []):
            for item_index, item in enumerate(tab.get("products") or []):
                link = item.get("link")
                if not link:
                    continue
                path = page_path(link)
                entry = products.setdefault(path, {"listings": []})
                entry["listings"].append({
                    "title": clean(item.get("title")),
                    "description": strip_tags(item.get("description")),
                    "group": group,
                    "category": clean(tab.get("tabLabel")) or group,
                    "order": (group_rank(group), tab_index, item_index),
                    # Prudential's own labels for the plan (any number)
                    "tags": [clean(t) for t in (item.get("productTag") or []) if clean(t)],
                })

    for path, group, position in direct:
        entry = products.setdefault(path, {"listings": []})
        if group:
            entry["listings"].append({
                "title": "",
                "description": "",
                "group": group,
                "category": group,
                "order": (group_rank(group), 0, position),
            })
        elif not entry["listings"]:
            # only linked from a page's text: list it under its own URL group
            g = group_of(path)
            entry["listings"].append({
                "title": "", "description": "", "group": g, "category": g,
                "order": (group_rank(g), 99, position),
            })

    return products, errors, len(models)


def build():
    products, errors, model_count = collect_product_list()
    print(f"Product lists: {model_count}, product pages: {len(products)}")

    records = []
    failed = []

    for path, info in sorted(products.items()):
        url = BASE + path
        try:
            html = get(url)
        except Exception as error:  # noqa: BLE001
            failed.append(f"{path}: {error}")
            continue
        if not html:
            failed.append(f"{path}: not found")
            continue

        parser = PageParser()
        parser.feed(html)

        documents = []
        seen = set()
        for href, text in parser.links:
            absolute = urljoin(url, href).split("#")[0]
            host = urlparse(absolute).netloc.lower()
            if absolute in seen or not host.endswith("prudential.com.sg"):
                continue
            seen.add(absolute)
            kind, label, lang = classify(href, text)
            if kind != "brochure":
                continue          # brochures only
            documents.append({"kind": kind, "label": label, "lang": lang, "url": absolute})

        if not documents:
            # no brochure on this page (e.g. fund pages)
            continue

        # Same label twice (e.g. several "FAQ" files): add the file name
        labels = [d["label"] for d in documents if d["kind"] != "brochure"]
        for doc in documents:
            if doc["kind"] != "brochure" and labels.count(doc["label"]) > 1:
                doc["label"] = f'{doc["label"]} – {name_from_file(doc["url"])}'

        documents.sort(key=lambda d: (d["kind"] != "brochure", d["lang"] != "EN", d["label"].lower()))

        name, description, categories, placements, tags = resolve(info["listings"], parser)

        if not placements:
            g = group_of(path)
            placements = [{"group": g, "category": g, "order": [group_rank(g), 99, 0]}]

        records.append({
            "id": path.strip("/").split("/")[-1],
            "name": name,
            "group": placements[0]["group"],
            "groups": list(dict.fromkeys(p["group"] for p in placements)),
            "categories": categories,
            "tags": tags,
            "placements": placements,
            "description": description,
            "pageUrl": url,
            "documents": documents,
        })

    # A product listed under a wrong link shares its page with another;
    # keep one record per page (already unique by path).
    records.sort(key=lambda r: (r["placements"][0]["order"], r["name"].lower()))

    return records, errors + failed


def download_brochures(records, target: Path):
    """Downloads every brochure into target/ as <product>-<EN|CN>.pdf
    and adds "file" (site path) and "bytes". -> (ok, unique, problems)"""
    done = {}            # url -> (site path, bytes) or (None, None)
    used = set()
    problems = []

    for record in records:
        for doc in record["documents"]:
            url = doc["url"]

            if url in done:
                doc["file"], doc["bytes"] = done[url]
                continue

            base = re.sub(r"[^A-Za-z0-9-]+", "-", record["id"]).strip("-") or "brochure"
            name = f"{base}-{doc['lang'] or 'EN'}.pdf"
            counter = 2
            while name.lower() in used:
                name = f"{base}-{doc['lang'] or 'EN'}-{counter}.pdf"
                counter += 1
            path = target / name

            size = 0
            last = None
            for attempt in range(1, RETRIES + 1):
                try:
                    response = session.get(url, timeout=120, stream=True)
                    response.raise_for_status()
                    size = 0
                    with open(path, "wb") as handle:
                        for chunk in response.iter_content(1024 * 256):
                            size += len(chunk)
                            if size > MAX_PDF_BYTES:
                                raise RuntimeError("larger than 90 MB")
                            handle.write(chunk)
                    with open(path, "rb") as handle:
                        if handle.read(5) != b"%PDF-":
                            raise RuntimeError("not a PDF")
                    last = None
                    break
                except Exception as error:  # noqa: BLE001
                    last = error
                    path.unlink(missing_ok=True)
                    time.sleep(attempt * 2)

            if last:
                problems.append(f"Download {url}: {last}")
                done[url] = (None, None)
                doc["file"], doc["bytes"] = None, None
                continue

            used.add(name.lower())
            site_path = f"{PDF_DIR.name}/{name}"
            done[url] = (site_path, size)
            doc["file"], doc["bytes"] = site_path, size
            time.sleep(PAUSE)

    ok = sum(1 for file, _ in done.values() if file)
    return ok, len(done), problems


def write_summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")


def main() -> int:
    try:
        records, problems = build()
    except Exception as error:  # noqa: BLE001
        records, problems = [], [f"Fetch failed: {error}"]

    def fail(message):
        print(message)
        for problem in problems[:30]:
            print("  -", problem)
        write_summary(["## Brochures (Annex)", "", f"❌ {message}", ""] + [f"- {p}" for p in problems[:30]])
        return 1

    if len(records) < MIN_PRODUCTS:
        return fail(
            f"Only {len(records)} products found (minimum {MIN_PRODUCTS}). "
            "Nothing was changed; the Annex keeps the last list."
        )

    # Download into a fresh folder, then swap it in: every previous
    # brochure is removed and only this run's files remain.
    staging = Path(tempfile.mkdtemp(prefix="brochure-"))
    downloaded, unique, download_problems = download_brochures(records, staging)
    problems += download_problems

    if not unique or downloaded / unique < MIN_DOWNLOADED:
        shutil.rmtree(staging, ignore_errors=True)
        return fail(
            f"Only {downloaded} of {unique} brochures downloaded. "
            "Nothing was changed; the Annex keeps the last list."
        )

    if PDF_DIR.exists():
        shutil.rmtree(PDF_DIR)
    shutil.copytree(staging, PDF_DIR)
    shutil.rmtree(staging, ignore_errors=True)
    (PDF_DIR / "README.md").write_text(BROCHURE_README, encoding="utf-8")

    brochure_count = sum(len(r["documents"]) for r in records)
    total_bytes = sum(size or 0 for _, size in {d.get("file"): d.get("bytes") for r in records for d in r["documents"]}.items() if _)

    output = {
        "generatedAtUtc": utc_now(),
        "source": BASE + "/en/products/",
        "productCount": len(records),
        "brochureCount": brochure_count,
        "downloadedCount": downloaded,
        "downloadedBytes": total_bytes,
        "products": records,
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=1), encoding="utf-8")

    summary = (
        f"{len(records)} products, {brochure_count} brochures; "
        f"{downloaded} of {unique} PDFs saved in {PDF_DIR.name}/ ({total_bytes / 1e6:.0f} MB)."
    )
    print(f"Wrote {OUTPUT_FILE.relative_to(ROOT)} and {PDF_DIR.name}/: {summary}")
    for problem in problems:
        print("  -", problem)

    write_summary(
        ["## Brochures (Annex)", "", f"✅ {summary}", ""]
        + ([f"Problems ({len(problems)}):", ""] + [f"- {p}" for p in problems[:30]] if problems else [])
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
