# Booli: where the listing data comes from

"Hämta uppgifter" on `/analysera` turns a Booli link into form values. It only fills the form: it
never starts the Priskoll or an analysis. For a `/bostad/<id>` link the same API also feeds the
table "Sålda lägenheter på <adress>" (`docs/plans/salt-i-huset.md`). Design and field map:
`docs/plans/booli-api.md`; research on Booli's sold data: `docs/research/booli-sold.md`.

There are two sources behind one interface (`AnnonsLeverantor` in `src/server/annons/kallor.ts`;
the answer says which one was used, `metod: "api" | "sida"`):

1. **The Booli REST API** (`booliApi.ts` + the pure mapping `booliApiTolkning.ts`): the default.
2. **The listing page** (`booliSida.ts` + the pure parser `booli.ts`): only with
   `ANNONS_SIDHAMTNING=on` (default off), as a fallback when the API fails with a key, network or
   parse error, or when the API is off. The production Worker is challenged by Cloudflare on the
   page, so it is off.

## Order of checks (`src/server/annons/hamta.ts`)

1. Input `{ url }`.
2. Kill switch `ANNONS_HAMTNING=off` → `avstangd`.
3. `kontrolleraAnnonsUrl` (`src/lib/annons/url.ts`, shared by client and server): https,
   `booli.se` or `www.booli.se`, path `/annons/<id>` or `/bostad/<id>`; canonicalised to
   `https://www.booli.se/<typ>/<id>`, which is also the cache key.
4. `annons_cache`, 24 h (a hit costs no quota and no call; rows are purged after 2 days).
5. No source on (no API keys or `BOOLI_API=off`, and the page source off) → `avstangd`, without
   taking quota.
6. Entitlement `hamta_annons`, then the quota (20 per device, 60 per IP per hour).
7. The source(s); a success is cached.

Every failure is returned as a buyer-safe Swedish message ("fyll i manuellt"); nothing throws for an
expected case. Logs are `[annons] …` lines naming the source.

## The Booli REST API

- `https://api.booli.se`, header `Accept: application/vnd.booli-v2+json`. Each call is signed:
  `callerId`, `time` (unix **seconds**), `unique` (16 hex characters) and
  `hash = sha1(callerId + time + privateKey + unique)`, computed with Web Crypto (the code runs on
  Cloudflare Workers). The request URL holds the caller id and hash, so it is never logged.
- Not behind Cloudflare: plain server `fetch` works. No rate-limit headers; about 160 calls in two
  minutes were never throttled. Each call has an 8 s deadline and is never retried.
- Key: a student key valid about three months from 2026-10-31; Booli's representative approved the
  use (owner). An expired key logs `[annons] booli-api nyckel avvisad` and the buyer fills in the
  form by hand.
- Env (web app only, never `VITE_`): `BOOLI_CALLER_ID` + `BOOLI_PRIVATE_KEY` (absent → API
  skipped), `BOOLI_API=off`, `ANNONS_SIDHAMTNING=on`, `ANNONS_HAMTNING=off` (everything).

### `/annons/<id>` (a listing id)

`listings/{id}` (active) → on 404 or an empty list `sold/{id}` → `areas?lat&lng` for the postcode
(listings carry none; the `Postnummer` area matched the sold rows' own `postCode` in 3 of 3 checks).
1–3 calls.

### `/bostad/<id>` (a residence id: the link buyers actually paste)

A residence id is a different number space and is **never** sent as `listings/{id}` (the numbers
collide, so it could hit another flat's listing). It is resolved with the `residenceId` filter
(checked 2026-11-01 against four saved residence pages, field by field; a made-up id gives 0 hits):

1. `listings?residenceId` (active; the latest published wins);
2. `listings?residenceId&upcomingSale=1` ("kommande" listings are hidden by default);
3. `sold?residenceId&sort=soldDate&direction=desc` (the flat's own sales; the latest wins). A sale
   older than 365 days fills only the flat's own facts, not utgångspris or avgift;
4. `areas?lat&lng` for the postcode.

An answer that does not echo `searchParams.residenceId`, or has more than 50 hits, is refused
(`tolkning`): a filter Booli ignored would return other flats. 1–4 calls.

### Mapping (`booliApiTolkning.ts`)

| Form field   | API                                                             |
| ------------ | --------------------------------------------------------------- |
| adress       | `location.address.streetAddress`                                |
| postnummer   | sold: `address.postCode`; listing: `areas` type `Postnummer`    |
| ort          | `region.municipalityName` (server geocoder only; no form field) |
| utgangspris  | `listPrice` (> 0; a sold listing too, never the sold price)     |
| manadsavgift | `rent` (> 0; `0` means not stated)                              |
| boarea       | `livingArea`                                                    |
| antalRum     | `rooms`                                                         |
| vaning       | `floor` (≥ 0, truncated: 1.5 → 1, as for typed input)           |
| byggar       | `constructionYear` (plausible range)                            |
| hiss         | `buildingHasElevator`: 1 → "ja", 0 → "nej"                      |
| balkong      | `hasBalcony`: 1 → "ja", 0 → "nej" unless `hasPatio` is 1        |
| context      | stadsdel `namedAreas[0]`, koordinater `position`                |

- Hiss/balkong (owner 2026-10-31): an explicit `0` means "nej", **except on a sparse listing**
  (at least two of rent, floor, construction year and asking price missing), where a `0` stays
  unknown: a fresh listing was seen with every amenity at `0` and no rent, price, floor or year
  (`glestObjekt`).
- Positions carry `isApproximate: true`. The API has no förening name, no broker listing URL and no
  description. Booli's own `estimate` is never read.

### Sales at the flat's address

For a `/bostad/<id>` link only, `hamtaForsaljningarFn` → `hamtaForsaljningar`
(`src/server/annons/forsaljningar.ts`), with the same kill switch, entitlement and quota:

1. `sold?residenceId=<id>&sort=soldDate&direction=desc` (with the echo and 50-hit guard): the
   flat's own sales, tagged "Den här lägenheten";
2. the flat's address and position from its newest sale, else from its listing
   (`listings?residenceId`, then `upcomingSale=1`);
3. `sold?center=<lat>,<lng>&dim=200,200&objectType=Lägenhet&minSoldDate=<today − 10 years>&limit=1000`,
   kept only where `streetAddress` equals the flat's address (case, spacing and "30 A" / "30A"
   ignored; the number and letter must match). Positions are approximate on most rows, so the
   address filter decides. A failed box search still shows the flat's own sales.

Rows (`tolkaSaldRad`, `sammanstallForsaljningar`): sold date (YYYY-MM-DD, else dropped), sold price
(positive integer, else dropped), living area, rooms, floor, rent (0 → none); never
`apartmentNumber`, `estimate` or the price source. One row per sale (Booli id, else date + price),
newest first, at most 100. 2–4 calls; cached 24 h in `annons_cache` under `booli-salda:v2:<id>`.
Display only, never a valuation input.

### Checking against the live API

`node --env-file=.env.local --import tsx scripts/testaBooliApi.ts [--spara]` prints per-field
status (never the keys); `--spara` refreshes the recorded answers in `fixtures/booli-api/` (keys
masked). The tests run on those recordings. They are Booli's data and are **not published in this
public repository** (gitignored), so the API mapping tests need a local copy.

## The listing page (fallback, off by default)

### Blocking

www.booli.se is behind Cloudflare bot management. The verdict depends on the client's fingerprint,
not just its headers:

| Client                                                                                                | Result                                   |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| curl, default user agent                                                                              | `403`, `cf-mitigated: challenge`         |
| curl, Chrome user agent, no `br` in `Accept-Encoding`                                                 | `403` challenge                          |
| curl, full Chrome-like header set (`Accept-Encoding: gzip, deflate, br`, `sec-ch-ua*`, `Sec-Fetch-*`) | `200`, real page                         |
| Node 22 `fetch` (undici), same headers                                                                | `403` challenge (TLS fingerprint)        |
| Local workerd (`wrangler dev`), Chrome-like headers, no `Accept-Encoding`                             | `200`, real page                         |
| Booli GraphQL (`/graphql`) from curl, full header set                                                 | `403` challenge                          |
| Production Worker (Cloudflare egress)                                                                 | **challenged** (`blockerad`, 2026-10-24) |

Binfo sends one request with a normal browser header set and never tries to solve or bypass a
challenge; a challenge is reported as `blockerad` and the buyer fills in the form. Header order
matters for curl too: `scripts/hamtaBooliFixtures.ts` uses an order that passes. `robots.txt` does
not disallow listing pages; Booli's website terms were not reviewed for page fetching.

### Where the fields are

The page is a Next.js app-router page. The parser (`tolkaBooli` in `booli.ts`) reads structured data
only, never the visible HTML:

1. concatenate every `self.__next_f.push([1,"…"])` string (each a JSON string literal);
2. JSON-parse the object that starts at `"object":{"__typename":"Listing"`;
3. add JSON-LD (`<script type="application/ld+json">`): `Place` (postal address), `Product`
   (price) and `BreadcrumbList` (ending in the BRF name).

| Field             | Path                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| Address           | `Listing.streetAddress` (= JSON-LD `Place.address.streetAddress`)             |
| Postcode          | JSON-LD `Place.address.postalCode`; `Listing.areas[type=postcode].name`       |
| Coordinates       | `Listing.latitude`, `Listing.longitude`                                       |
| Kommun / stadsdel | `areas[type=municipality].name` / `descriptiveAreaName`, `primaryArea.name`   |
| Utgångspris       | `listPrice.raw` (null before the sale starts)                                 |
| Avgift            | `rent.raw`, kr/mån; `0` when the broker gave none                             |
| Boarea            | `livingArea.raw` (decimal)                                                    |
| Rum               | `rooms.raw` (2.5 possible)                                                    |
| Våning            | `floor.raw`                                                                   |
| Byggår            | `constructionYear`                                                            |
| Hiss / balkong    | `amenities[].key` `elevator` / `balcony`, listed only when present            |
| Förening          | last JSON-LD breadcrumb (`/bostadsrattsforening/<id>`); `housingCoop.id`      |
| Broker page       | `listingUrl` ("Läs mer hos mäklaren")                                         |
| Not used          | `operatingCost`, `heating`, `apartmentNumber`, `estimate` (Booli's valuation) |

- A missing amenity is unknown, not "no": from the page, hiss/balkong are only ever set to "ja".
- Listings change while live (price set later, förening name edited), so a re-fetch can differ.
- When the postcode is missing, `geokod.ts` asks Nominatim (OpenStreetMap) with the listing's
  coordinates or address. An optional Haiku fallback (`llmFallback.ts`, `ANNONS_LLM_FALLBACK=on`,
  default off) reads the page when structured parsing fails.
- The "Föreningen" tab loads lazily (name, type, unit count, land ownership, total loan); its
  nyckeltal need a Booli login. Earlier sales on the page come from Booli's GraphQL with persisted
  queries (`salesOfProperty`, `comparableSales`), which are challenged for servers; Binfo uses the
  API's `sold` endpoint instead.

### Fixtures

`fixtures/booli/` holds six listing pages and a Cloudflare challenge page as served to a server
(fetched with curl 2026-10-24), plus recorded Nominatim answers and `booli_links.txt`. The HTML
pages are Booli's content and are **not published in this public repository** (gitignored); the
parser tests that read them need a local copy. Re-fetch them with
`node --import tsx scripts/hamtaBooliFixtures.ts` (`--spara` overwrites them).
