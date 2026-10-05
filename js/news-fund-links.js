/* ============================================================
   VGRAT FMS — NEWS ↔ FUND LINKS
   ============================================================

   Links each analysed news article to the Prudential funds it
   may affect, using only data already in the repository:

   Article (AI analysis)          Fund (funds.json)
   ---------------------          -----------------
   geographies[]          <->     research.geographic1 / 2
   sectors[]              <->     research.sector1 / 2
   assetClasses[]         <->     fund.assetClass

   Rules (kept deliberately simple and explainable):

   1. Geography must match. A fund researched as "Global",
      or an article tagged "Global", counts as a geography
      match. Regions expand to their markets (e.g. an "Asia"
      article matches China, Taiwan, Singapore ... funds).

   2. Then either:
      - SECTOR match   -> "direct" link (stronger), or
      - ASSET match    -> "broad" link (weaker)

   An article tagged "Global" only links on a sector match,
   otherwise every fund would be linked to it.

   This is an indication of possible exposure, not a holdings
   analysis.
   ============================================================ */


/* ============================================================
   VOCABULARY NORMALISATION
   ============================================================ */

const SECTOR_MAP = {
    "information technology": "Information Technology",
    "technology": "Information Technology",
    "semiconductors": "Information Technology",
    "artificial intelligence": "Information Technology",
    "software": "Information Technology",
    "it services": "Information Technology",
    "internet infrastructure": "Information Technology",
    "consumer electronics": "Information Technology",
    "robotics": "Information Technology",

    "financials": "Financials",
    "financial services": "Financials",
    "fintech": "Financials",
    "insurance": "Financials",
    "asset management": "Financials",
    "banking": "Financials",
    "banks": "Financials",

    "health care": "Health Care",
    "healthcare": "Health Care",
    "pharmaceuticals": "Health Care",
    "biotechnology": "Health Care",

    "industrials": "Industrials",
    "industrial": "Industrials",
    "aerospace": "Industrials",
    "defense": "Industrials",
    "defence": "Industrials",
    "construction": "Industrials",
    "transportation": "Industrials",
    "shipping": "Industrials",
    "space": "Industrials",

    "consumer discretionary": "Consumer Discretionary",
    "automotive": "Consumer Discretionary",
    "apparel": "Consumer Discretionary",
    "retail": "Consumer Discretionary",
    "homebuilding": "Consumer Discretionary",
    "toys": "Consumer Discretionary",
    "consumer goods": "Consumer Discretionary",
    "entertainment": "Consumer Discretionary",

    "communication services": "Communication Services",
    "telecommunications": "Communication Services",
    "media": "Communication Services",

    "utilities": "Utilities",

    "real estate": "Real Estate",

    "energy": "Energy",
    "oil & gas": "Energy",
    "oil and gas": "Energy",

    "materials": "Materials",

    "consumer staples": "Consumer Staples",

    "government": "Government Bonds",
    "municipal": "Government Bonds",
    "government bonds": "Government Bonds",

    "corporate bonds": "Corporate Bonds",

    "cash": "Cash & Equivalents",
    "cash & equivalents": "Cash & Equivalents"
};


/*
 * Article asset classes -> fund asset classes they touch.
 */
const ASSET_MAP = {
    "equities": ["Equity", "Multi-Asset"],
    "equity": ["Equity", "Multi-Asset"],
    "stocks": ["Equity", "Multi-Asset"],

    "fixed income": ["Fixed Income", "Multi-Asset"],
    "bonds": ["Fixed Income", "Multi-Asset"],
    "government debt": ["Fixed Income", "Multi-Asset"],
    "treasurys": ["Fixed Income", "Multi-Asset"],
    "treasuries": ["Fixed Income", "Multi-Asset"],
    "debt": ["Fixed Income", "Multi-Asset"],
    "credit": ["Fixed Income", "Multi-Asset"],

    "cash": ["Money Market"],
    "money market": ["Money Market"]
};


/*
 * Geography: each name -> the set of markets it covers.
 * A fund matches if any of its research geographies is in
 * the article's expanded set (or vice versa for regions).
 */
const REGION_MEMBERS = {
    "Asia": [
        "Asia", "Asia Pacific", "China", "Greater China", "Hong Kong",
        "Taiwan", "Japan", "South Korea", "Singapore", "India",
        "ASEAN", "Southeast Asia", "Vietnam", "Thailand", "Indonesia",
        "Malaysia", "Philippines"
    ],
    "Asia Pacific": [
        "Asia", "Asia Pacific", "China", "Greater China", "Hong Kong",
        "Taiwan", "Japan", "South Korea", "Singapore", "India",
        "ASEAN", "Southeast Asia", "Australia", "New Zealand"
    ],
    "Southeast Asia": [
        "Southeast Asia", "ASEAN", "Singapore", "Vietnam", "Thailand",
        "Indonesia", "Malaysia", "Philippines"
    ],
    "ASEAN": [
        "Southeast Asia", "ASEAN", "Singapore", "Vietnam", "Thailand",
        "Indonesia", "Malaysia", "Philippines"
    ],
    "Greater China": ["Greater China", "China", "Hong Kong", "Taiwan"],
    "China": ["China", "Greater China", "Hong Kong"],
    "Hong Kong": ["Hong Kong", "Greater China", "China"],
    "Taiwan": ["Taiwan", "Greater China"],
    "Europe": [
        "Europe", "Eurozone", "European Union", "United Kingdom",
        "Germany", "France", "Switzerland", "Netherlands", "Italy",
        "Spain", "Nordics", "Eastern Europe", "Ireland"
    ],
    "Eurozone": ["Europe", "Eurozone", "European Union", "Germany", "France", "Netherlands", "Italy", "Spain", "Ireland"],
    "North America": ["North America", "United States", "Canada"],
    "Middle East": ["Middle East", "Saudi Arabia", "United Arab Emirates", "Qatar", "Oman", "Iran", "Israel"]
};


/*
 * A specific country also belongs to its region, so a fund
 * researched as "Europe" picks up a "Germany" article.
 */
const PARENT_REGIONS = {};

for (const [region, members] of Object.entries(REGION_MEMBERS)) {
    for (const member of members) {
        if (member === region) continue;
        (PARENT_REGIONS[member] ??= new Set()).add(region);
    }
}


function clean(value) {
    return String(value ?? "").trim();
}

function isBlank(value) {
    const text = clean(value);
    return !text || text === "—" || text === "-";
}

function expandGeography(name) {
    const result = new Set([name]);

    for (const member of REGION_MEMBERS[name] ?? []) {
        result.add(member);
    }

    for (const parent of PARENT_REGIONS[name] ?? []) {
        result.add(parent);
    }

    return result;
}

function normaliseSector(value) {
    return SECTOR_MAP[clean(value).toLowerCase()] ?? clean(value);
}


/* ============================================================
   FUND PROFILES
   ============================================================ */

function buildFundProfile(fund) {
    const research = fund?.research ?? {};

    const geographies = [research.geographic1, research.geographic2]
        .filter(value => !isBlank(value))
        .map(clean);

    const sectors = [research.sector1, research.sector2]
        .filter(value => !isBlank(value))
        .map(normaliseSector);

    return {
        fund,
        id: String(fund.fundIdentifier ?? fund.fundCode ?? fund.fundName ?? ""),
        code: fund.fundCode ?? "",
        name: fund.fundName ?? "",
        assetClass: clean(fund?.fund?.assetClass),
        isGlobal: geographies.includes("Global"),
        geographies,
        sectors: new Set(sectors)
    };
}


/* ============================================================
   LINKER
   ============================================================ */

function createFundLinker(funds) {
    const profiles = (Array.isArray(funds) ? funds : [])
        .map(buildFundProfile)
        .filter(profile => profile.id);

    const cache = new Map();

    function linkArticle(article) {
        const key = article?.articleId ?? article?.id ?? article?.url;

        if (key && cache.has(key)) {
            return cache.get(key);
        }

        const articleGeos = (article?.geographies ?? []).map(clean).filter(Boolean);
        const articleSectors = (article?.sectors ?? []).map(normaliseSector);
        const articleAssets = new Set(
            (article?.assetClasses ?? []).flatMap(
                value => ASSET_MAP[clean(value).toLowerCase()] ?? []
            )
        );

        const articleIsGlobal = articleGeos.includes("Global");

        const expandedGeos = new Set();

        for (const geo of articleGeos) {
            for (const item of expandGeography(geo)) {
                expandedGeos.add(item);
            }
        }

        const links = [];

        for (const profile of profiles) {
            /*
             * Asset-class gate: when the article names an asset
             * class we understand, the fund must hold that kind
             * of asset (equity news does not link to bond funds).
             */
            if (articleAssets.size && !articleAssets.has(profile.assetClass)) {
                continue;
            }

            const geoHits = profile.geographies.filter(geo => expandedGeos.has(geo));

            const primaryGeoHit =
                profile.geographies[0] !== undefined &&
                expandedGeos.has(profile.geographies[0]);

            const sectorHits = [...new Set(articleSectors.filter(sector => profile.sectors.has(sector)))];

            const primarySectorHit = sectorHits.includes([...profile.sectors][0]);

            /*
             * Score (higher = more relevant):
             *   geography  primary 2 · secondary 1 · via Global 0
             *   sector     primary 2 · secondary 1
             */
            const geoScore = primaryGeoHit ? 2 : geoHits.length ? 1 : 0;

            const sectorScore = primarySectorHit ? 2 : sectorHits.length ? 1 : 0;

            const geoMatch = geoScore > 0 || profile.isGlobal || articleIsGlobal;

            if (!geoMatch || sectorScore === 0) {
                continue;
            }

            const score = geoScore + sectorScore;

            /*
             * direct = specific geography AND sector match
             * broad  = sector match through a Global fund/article
             */
            const strength = geoScore > 0 ? "direct" : "broad";

            const reasons = [
                ...(geoHits.length ? geoHits : ["Global"]),
                ...sectorHits
            ];

            links.push({
                fundId: profile.id,
                fundCode: profile.code,
                fundName: profile.name,
                strength,
                score,
                reasons
            });
        }

        links.sort((a, b) => {
            if (a.score !== b.score) {
                return b.score - a.score;
            }

            return a.fundName.localeCompare(b.fundName);
        });

        if (key) {
            cache.set(key, links);
        }

        return links;
    }

    return {
        linkArticle,
        funds: profiles
            .map(profile => profile.fund)
            .sort((a, b) => String(a.fundName).localeCompare(String(b.fundName)))
    };
}


export {
    createFundLinker
};
