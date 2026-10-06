# Prudential Singapore Promotions Extractor

Automatically extracts current Prudential Singapore promotions.

## Source

Prudential Singapore:

https://www.prudential.com.sg/en/promos-and-rewards/promotions/

## Output

The extractor generates:

data/promotions.json

The JSON contains:

- promotion title
- promotion summary
- promotion URL
- promotion periods
- promotion status
- eligible plans
- payment modes
- rewards and discounts
- page headings
- complete cleaned promotion-page text
- extraction status
- extraction errors

## Repository Structure

    .
    ├── .github/
    │   └── workflows/
    │       └── extract-promotions.yml
    │
    ├── data/
    │   └── promotions.json
    │
    ├── scripts/
    │   └── extract_promotions.py
    │
    ├── .gitignore
    ├── README.md
    └── requirements.txt

## Running Locally

Install dependencies:

    pip install -r requirements.txt

Run:

    python scripts/extract_promotions.py

Output:

    data/promotions.json

## GitHub Actions

The workflow runs automatically once per day.

It can also be started manually from:

Actions
→ Extract Prudential Promotions
→ Run workflow

The scheduled workflow runs at:

00:00 UTC
08:00 Singapore Time

## Promotion Discovery

Promotion URLs are discovered dynamically from the Prudential
promotions landing page.

The extractor does not hardcode the number of promotions.

This allows new Prudential promotions to be picked up
automatically when Prudential adds them to the website.

## Promotion Status

Each promotion receives one of:

- active
- upcoming
- expired
- unknown

Status is determined using the promotion periods extracted
from the official Prudential promotion page.

## Source Authority

The Prudential promotion detail page is treated as the
authoritative source for promotion information.

The landing-page card is used primarily for discovery and
summary information.

## Disclaimer

This repository extracts publicly available information
from Prudential Singapore's website.

The extracted content should not be treated as a substitute
for the official promotion terms and conditions.
