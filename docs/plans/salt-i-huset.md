# Plan: sold flats at the same address ("Sålda lägenheter på <adress>")

Written 2026-11-01. **Status: implemented 2026-11-01.** Background: `docs/research/booli-sold.md`
§7 (use case A) and `docs/booli.md` (the `residenceId` filter, the API calls in detail).

## 1. What it is

For a flat the buyer linked with a `/bostad/<id>` Booli link, a simple table of every flat sold at
the same street address in the last 10 years, newest first, with the linked flat's own sales tagged
"Den här lägenheten". It is shown only: never a valuation input, and the valuation is never called
"bekräftad" by it (owner 2026-11-01).

A `/bostad/<id>` link is the flat itself, so `sold?residenceId=<id>` returns exactly that flat's
sales without matching on address, `apartmentNumber` and boarea. The first version showed only
those; after a real test showed nothing for a flat that had never been sold, the owner widened it
the same day to the whole address. An `/annons/<id>` link has no residence id and gets no table.

## 2. What is shown

Heading "Sålda lägenheter på <adress>" ("… på samma adress" when the address is unknown).

| Column  | Content                       |
| ------- | ----------------------------- |
| Såld    | month and year                |
| Pris    | sold price                    |
| kr/m²   | sold price ÷ living area      |
| Storlek | boarea and rooms              |
| Våning  | `floor`; "—" when missing     |
| Avgift  | `rent`; "—" when 0 or missing |

- Five rows, then "Visa alla (n)". The PDF shows the five newest with "Visar de 5 senaste av n
  försäljningar." and stars the flat's own sales.
- Footnote "Försäljningar de senaste 10 åren. Äldre priser är inte justerade för
  prisutvecklingen." and the attribution "Uppgifter från Booli".
- On a phone each sale becomes two lines.
- Empty → the block is not shown (no "inga försäljningar": Booli's coverage cannot support that
  claim).
- Never shown: `apartmentNumber`, Booli's `estimate`, the price source codes.
- No "mot utgångspris" column (missing on about one sale in five).

**Placement** (owner: both pages, after the valuation, as its own card so the sales do not read as
part of the calculation):

- full report, section "Priset": after the price card and the "Så har vi räknat" details
  (`src/components/rapport/RapportPris.tsx`), web and PDF;
- `/analysera`, the Priskoll result: after "Vad värderingen bygger på"
  (`src/components/analysera/PriskollResultat.tsx`), only when the form was filled from a
  `/bostad/` link.

## 3. Design

- **Fetched on open, not stored.** The client calls `hamtaForsaljningarFn` with the canonical
  `/bostad/` URL (`useTidigareForsaljningar`); the report takes it from `PropertyInput.kalla.url`.
  The report never waits for it, and a Booli failure shows nothing. No contract change: once the
  12-month retention blanks `kalla`, the table is gone too.
- **Server** (`src/server/annons/forsaljningar.ts`): kill switch, URL check (`/bostad/` only), API
  keys → cache → entitlement `hamta_annons` and the listing quota → `sold?residenceId` (the flat's
  own) → the address and position from its newest sale, else its listing → a 200 × 200 m
  `sold?center&dim` box from 10 years back, filtered on the exact address (number and letter must
  match; case and spacing ignored). 2–4 calls; a failed box search still returns the flat's own
  sales.
- **Cache:** `annons_cache` under `booli-salda:v2:<id>`, 24 h (an empty answer too); purged after 2
  days by `binfo-retention`. No migration.
- **Types and texts:** `src/lib/annons/forsaljningar.ts` (answer shape; at most 100 rows kept, 5
  shown, 10 years), `forsaljningarVy.ts` (web and PDF texts), component
  `src/components/rapport/TidigareForsaljningar.tsx`.
- Behind the same flags as the prefill (`BOOLI_API=off`, `ANNONS_HAMTNING=off`). An expired key
  hides the block and logs `booli-api nyckel avvisad`.

## 4. Privacy and terms

- Date and price of one flat are public on Booli, but together with the address they can point to
  a seller. Binfo shows them only to the buyer who pasted the link and keeps them only in the 24 h
  cache. `/integritet` describes it.
- Booli's representative approved showing the data (owner). The student key expires around
  2027-01-31.

## 5. Tests

- Unit: the row mapping (dates, prices, `rent` 0, half floors), the address filter, de-duplication,
  sort order and the 100-row bound, the cache, and that nothing is returned without a `/bostad/`
  link or with the API off.
- UI: render tests for the web block and the PDF view model; the text matches the numbers.
