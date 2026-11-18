# Plan: listing data via the Booli API

Written 2026-10-31. **Status: implemented** (prefill 2026-10-31, `/bostad/<id>` links 2026-11-01).
The current behaviour is described in `docs/booli.md`; this file keeps the design and the owner's
decisions. Research on earlier sales: `docs/research/booli-sold.md`.

## 1. Why the API

Scraping the listing page works from curl and workerd, but the production Worker is challenged by
Cloudflare there (`docs/booli.md`). The Booli REST API is not behind Cloudflare, works from a plain
server `fetch`, and returns the same listing facts as structured JSON.

What the API offers (verified with signed calls, 2026-10-31):

- `https://api.booli.se`, header `Accept: application/vnd.booli-v2+json`, query params
  `callerId`, `time` (unix seconds), `unique` (16 hex characters),
  `hash = sha1(callerId + time + privateKey + unique)`. No rate-limit headers.
- `listings/{booliId}` → `{ listings: [ … ] }`, or `404 {"listings":[]}`. `booliId` is the number
  in `booli.se/annons/<id>`.
- `booli.se/bostad/<id>` carries a **residence id**, a different numbering. The two number spaces
  collide, so a residence id must never be sent to `listings/{id}` (risk: the wrong flat). The
  `residenceId` filter on `listings` and `sold` resolves it.
- A sold row has `soldPrice`, `soldDate`, `listPrice`, `location.address.postCode`,
  `apartmentNumber`, `soldPriceSource`.
- `areas?lat=&lng=` returns every area containing the point, including one of type `Postnummer`:
  Booli's own postcode for an active listing, which carries none.
- An active listing has `streetAddress`, `position`, `region.municipalityName`, `namedAreas`,
  `listPrice`, `rent`, `livingArea`, `rooms`, `floor` (can be 1.5), `constructionYear`,
  `buildingHasElevator` 0/1, `hasBalcony` 0/1, `hasPatio`, `objectType`, `published`, `url`. **No
  postcode, no förening name, no description.**

## 2. Field mapping (API → form → downstream)

| Form field (`ANNONS_FALT`) | API source                                                             | Used by                            |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| adress                     | `location.address.streetAddress`                                       | report, register area              |
| postnummer                 | listing: `areas?lat&lng` → type `Postnummer`; sold: `address.postCode` | valuation (area + postcode effect) |
| ort                        | `region.municipalityName`                                              | server geocoder only               |
| utgangspris                | `listPrice` (never `firstPrice`, never the sold price)                 | price comparison                   |
| manadsavgift               | `rent` (> 0; `0` = not stated)                                         | valuation (fee/m²), fee share      |
| boarea                     | `livingArea`                                                           | valuation, debt share              |
| antalRum                   | `rooms`                                                                | valuation                          |
| vaning                     | `floor`, ≥ 0, truncated to an integer                                  | valuation                          |
| byggar                     | `constructionYear` (plausible range)                                   | valuation                          |
| hiss                       | `buildingHasElevator` (D1)                                             | valuation driver                   |
| balkong                    | `hasBalcony` / `hasPatio` (D1)                                         | valuation (not significant)        |
| stadsdel, koordinater      | `namedAreas[0]`, `position`                                            | display, postcode lookup           |
| forening, maklarUrl        | not in the API                                                         | absent on the API path             |

The BRF analysis uses none of these values directly; it gets them through the buyer's
`PropertyInput`. The postcode is formatted `NNN NN`; the API path never calls Nominatim.

## 3. Design

- **Source interface** (`src/server/annons/kallor.ts`): `AnnonsLeverantor` has a name
  (`booli_api` or `booli_sida`), a `metod` (`api` or `sida`) and `hamta(lank, beroenden)`, which
  returns ok values or a failure code (`ej_tillganglig`, `nyckel`, `hittades_inte`, `blockerad`,
  `natverk`, `tolkning`). Two implementations: the API (`booliApi.ts` + pure mapping
  `booliApiTolkning.ts`) and the page (`booliSida.ts` around the parser `booli.ts`). When the key
  expires, another source is one new adapter.
- **Choice of source** (`hamta.ts`): the API when both keys are set and `BOOLI_API` is not `off`;
  the page only with `ANNONS_SIDHAMTNING=on` (default off), tried after an API failure with
  `nyckel`, `natverk`, `tolkning` or `ej_tillganglig`, or when the API is off. With no source on,
  the answer is `avstangd` before the entitlement and quota are touched.
- **Calls:** `/annons/<id>`: `listings/{id}` → on 404 `sold/{id}` → `areas` (1–3 calls).
  `/bostad/<id>`: `listings?residenceId` → `listings?residenceId&upcomingSale=1` →
  `sold?residenceId` → `areas` (1–4 calls); the answer must echo the filter and have at most 50
  hits. Signing with Web Crypto (`crypto.subtle`), no Node APIs; 8 s per call, no retry.
- **Cache:** the existing `annons_cache` (canonical URL, 24 h). `AnnonsSvar` (in
  `src/lib/annons/typer.ts`, not the shared contract) gained an optional `metod`; older cache rows
  still parse. No migration; `src/types/analysis.ts` unchanged (`AnnonsKalla.typ` stays `"booli"`).
- **Env** (web app only, never `VITE_`): `BOOLI_CALLER_ID`, `BOOLI_PRIVATE_KEY`, `BOOLI_API`,
  `ANNONS_SIDHAMTNING`; `ANNONS_HAMTNING=off` still turns everything off.
- **Attribution:** "Uppgifter från Booli" linking to booli.se on `/analysera` after a successful
  fetch, and a line in the report's sources and the PDF when `PropertyInput.kalla.typ === "booli"`.
  Booli's own `estimate` is never read or stored.
- **Quota:** the existing listing quota (20 per device, 60 per IP per hour); a cache hit costs no
  call.
- **Deploy:** the two key secrets in the web app's environment, then publish. No migration, no Edge
  Function change, no `PROMPT_VERSION` bump.

## 4. Tests

- Unit: signing (fixed inputs → known SHA-1), URL parsing and routing by link type, the mapping
  (recorded answers in `fixtures/booli-api/`, keys masked: active, sold, missing rent, half floor,
  no postcode, sparse listing, garbage), and the orchestration with an injected `fetch` (listing,
  404 → sold, key failure → manual or page, `/bostad` resolution, postcode via `areas`, flags off,
  keys absent, cache hit = zero calls).
- The recorded answers are Booli's data and are not published in this public repository
  (gitignored); the tests that read them need a local copy.
- Live check: `scripts/testaBooliApi.ts` prints per-field status for a few active and sold
  listings, never the keys; `--spara` refreshes the recordings.

## 5. Decisions (owner)

- **D1** (2026-10-31) Hiss: `buildingHasElevator` 1 → "ja", 0 → "nej". Balkong: `hasBalcony` 1 →
  "ja", 0 → "nej" unless `hasPatio` is 1 (then unknown). A missing key is unknown. Exception: on a
  sparse listing (at least two of rent, floor, construction year and asking price missing) a `0`
  stays unknown, because such listings send `0` for every amenity. The page parser only ever gives
  "ja".
- **D2** (revised 2026-11-01) Buyers paste `/bostad/<id>` links; they are resolved through the
  `residenceId` filter, never as a listing id. A sale of the residence older than 365 days fills no
  utgångspris or avgift.
- **D3** (2026-10-31) A sold listing fills utgångspris with its `listPrice`; the final price is
  never put in the form.
- **Terms:** Booli's representative approved the use; the student key lasts about three months.
  The attribution is shown anyway. The API is on by default, `BOOLI_API=off` turns it off.
