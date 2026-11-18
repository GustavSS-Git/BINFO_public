# Binfo

Independent buyer-side decision support for Swedish bostadsrätter
(https://binfo.slanesens.com). A buyer enters a flat (or pastes a Booli link)
and uploads the BRF's årsredovisning, and gets:

- a **BRF analysis**: the seven statutory nyckeltal, a grade A–E, red flags and
  questions for the styrelse;
- a **price check** against Binfo's own valuation model, adjusted for the
  expected rise in the monthly fee;
- a **bolånekalkyl** and a **köpguide**.

Competitors (Lusa, AI BRF, Allabrf) grade the _cooperative_. Binfo grades the
_transaction_: price, per-apartment cost in kronor, and what to do before
bidding.

This file is the working reference for the codebase. `README.md` is the short
public overview; `docs/DECISIONS.md` records product decisions.

## Status

- **Production:** 11 migrations applied; Edge Function on `PIPELINE_VERSION`
  `p16.i1.s1`; web app published through Lovable.
- **Booli API prefill** and "sold at the same address" are on `main`; they need
  the `BOOLI_*` secrets in Lovable to go live. See "Listing data".
- **This public repository** leaves out third-party data: the real annual
  reports used for testing, the Svensk Mäklarstatistik transaction xlsx files,
  recorded Booli pages/API answers and Booli bulk pulls. The tests that replay
  Booli fixtures are skipped when they are absent (`vitest.config.ts`), and the
  ML test that parses the xlsx is skipped (`ml/tests/test_regional.py`).

## Stack

- Vite + React 19 + TypeScript (strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), TanStack Start/Router (file routes), TanStack
  Query, Tailwind 4. **Not Next.js**: no app router, `/pages` or `server-only`.
- `vite.config.ts` is a thin wrapper around `@lovable.dev/vite-tanstack-config`
  (Lovable-owned). `vitest.config.ts` is deliberately separate from it.
- **Hosting:**
  - The web app (SSR + server functions) is built by Lovable for Cloudflare
    Workers (nitro `cloudflare-module`). Use web APIs only on the server path:
    no `Buffer`, no native modules.
  - The background worker is one Supabase Edge Function (Deno 2), `analys-steg`.
- **Backend:** Supabase (Postgres, pg_cron, pg_net, Storage, Vault, Auth), the
  Anthropic API via `@anthropic-ai/sdk` 0.125, Zod v3 (pinned deliberately),
  `unpdf` (pdf.js) for PDF text, `pdf-lib` for splitting scans.
- **Offline ML:** Python in `ml/` (pandas, LightGBM, statsmodels, pytest; venv at
  `ml/.venv`). The exported model JSON is evaluated in TypeScript at runtime.
  There is no Python in production.
- Node 22 (`.nvmrc`). The shell default may be newer, so prefix commands with
  `PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH` or run `nvm use`. The dev
  server runs on `localhost:8080` (forced by the wrapper).

## Repository map

### Top level

- `src/routes/`: file routes. `routeTree.gen.ts` is generated; never edit it.
  (`src/routes/README.md` is Lovable's note.)
- `src/router.tsx` (fresh `QueryClient` per `getRouter()`), `src/start.ts`
  (TanStack Start middleware: error page + CSRF filter on server functions),
  `src/server.ts` (SSR entry that turns swallowed 500s into an HTML error page;
  set via `tanstackStart.server.entry`), `src/styles.css` (Tailwind 4 `@theme`
  tokens), `src/hooks/use-mobile.tsx`.
- `src/types/analysis.ts`: **the contract** for an analysis result and the price
  check (`PrisInput`, `PrisuppskattningResultat`), shared by client and server.
- `src/data/`: `sampleAnalysis.ts` (the static `AnalysisResult` on `/exempel`)
  and `mockData.ts` (calculator defaults, fee items, the seed of the in-memory
  "osäkra uppgifter" store).
- `supabase/`: `migrations/` (11), `rollback/` (manual down-scripts, never
  auto-applied), Edge Function `functions/analys-steg/`, `config.toml` (local
  Auth config; references a `seed.sql` that doesn't exist, harmless).
- `ml/`: training, postcode/kommun mapping, model artifacts, pytest suite.
- `data/derived/`: postcode mapping CSVs, regional price levels, bid premium.
  `data/raw/` holds `riket_prisniva.csv` (the national average, owner-supplied).
- `fixtures/`: extraction answer keys (`answer-key/`, `answer-key-lan/`,
  `answer-key-underhall/`), `property-input-example.json`, and recorded
  Nominatim answers in `booli/`.
- `scripts/`: data builders, Booli tools, local-stack helpers (see Commands).
- `docs/`: specs and decisions (see "Reference docs").
- `.claude/`: subagent definitions and shared Claude Code permissions.

### `src/components/`

- `AnalysRapport.tsx` (the full report) with its sections in `rapport/`:
  `RapportForening`, `RapportPris`, `RapportAvgift`, `RapportFragor`,
  `RapportSlut` (sources and method), `Sammanfattningskort`,
  `TidigareForsaljningar`, `Prisrimlighet` (kept and re-exported, no longer used
  by any page).
- `AnalysStatus.tsx` (polling, waiting screen `Pagar`, `Misslyckad`,
  `HittadesInte`), `PropertySummary.tsx`, `SiteNav.tsx` (+ `SiteFooter`).
- `analysera/`: `PriskollResultat` (Priskoll result), `SparadVardering`
  (re-open a saved valuation).
- `pdf/`: PDF export via `@react-pdf/renderer`, lazy-loaded client-only.
  `download.tsx` → `AnalysPdfDocument.tsx`; `viewModel.ts` is the pure data
  layer; `fonts.ts`, `theme.ts`, `filename.ts` are shared with the kalkyl PDF
  (`KalkylPdfDocument`, `kalkylViewModel`, `downloadKalkyl`).
- `konto/` (`SparaKnapp`, `useSparaKalkyl`, `useSparaAnalys`, `SparaAnalysVy`,
  `ProfilListor`, `AuthSida`), `register/` (`RegisterLista`, `ForeningSida`),
  `kalkyl/` (`KalkylExport`), `kopguide/` (`KopguideVy`).
- `ui/binfo.tsx`: the Binfo UI kit (Card, Button, LinkButton, Field, Badge,
  Callout, TristateChoice, Tag, Toggle, PageHeader, GradeBadge, GradeScale,
  Logo…). The other `ui/*.tsx` files are shadcn primitives.

### `src/lib/` (client-safe)

- `analysis/`: the pipeline and read-time assembly (next section).
- `kalkyl/`: bolånekalkyl, pure. `underlag.ts` (`KalkylUnderlag` v2, versioned
  input shared by page, saved kalkyl and exports), `regler.ts` (every rule and
  constant with source and date, `REGELVERSION`, Konsumentverket 2026 tables),
  `berakna.ts` (`beraknaKalkyl`, `sammanfattaKalkyl`), `levnadskostnader.ts`
  (KALP), `indata.ts`, `sida.ts` (page state ↔ underlag), `xlsx.ts` (Excel
  export with live formulas; exceljs).
- `vardering/`: **server-only** valuation engine (see "Valuation").
- `annons/`: listing prefill. `typer.ts`, `url.ts` (`kontrolleraAnnonsUrl`,
  shared by client and server), `formular.ts` (applying an answer, per-field
  provenance), `forsaljningar.ts` + `forsaljningarVy.ts` (sales at the same
  address).
- `register/`: `omraden.ts` (19 register areas + `ovriga-stockholm`,
  `losRegisteromrade`) and the generated `data/postnummerStadsdel.data.ts`.
- `kopguide/`: `steg.ts` (the steps), `framsteg.ts`, `lagring.ts`,
  `useKopguide.ts`.
- `postnummer/`: postcode hint texts (`postnummerInfoText`,
  `postnummerFaltVisning`).
- View helpers: `analysisView.ts` (report texts and formatting), `prisVy.ts`,
  `priskollVy.ts`, `betygVy.ts`, `omradeText.ts`, `registerVy.ts`,
  `analysStatusVy.ts`, `analysStatusCopy.ts` (error copy; its code union is
  type-checked against the server's).
- Forms and state: `analyseraForm.ts`, `varderingForm.ts`, `bolanekalkyl.ts`
  (calculator search params), `uppgifter.ts` (in-memory store shared across
  routes), `utkast.ts` (logged-out save drafts), `senasteAnalyser.ts`,
  `session.ts`, `till.ts` (`saneraTill`: same-origin redirects only),
  `kontoTyper.ts`, `startExempel.ts`.
- Other: `skatt2026.ts` (2026 income tax, per-person ränteavdrag),
  `propertyType.ts`, `kontakt.ts` (`KONTAKT_EPOST`), `sitemap.ts`, `utils.ts`,
  `error-capture.ts`, `error-page.ts`, `lovable-error-reporting.ts`.

### `src/lib/analysis/`

- **Text layer and identity:** `pdf.ts`, `textlager.ts` (`ok` / `saknas` /
  `trasigt`), `identitet.ts` (local orgnr/year/name), `identitetModell.ts`
  (Haiku on pages 1–3).
- **Scans:** `transkribering.ts`, `transkriptionsblock.ts` (parallel page
  transcription → citable custom-content document).
- **Extraction:** `runExtraction.ts` (grounding + structured extraction, pure
  `bygg*Request` / `tolka*Svar`), `extract.ts` (`extractWithRetry`: one blind
  re-roll), `slutfor.ts` (the single post-model validator), `sidreferenser.ts`
  (verifies cited excerpts), `rimlighet.ts` (sanity checks → `Figure.osaker`),
  `tolkaVarde.ts`, `benchmarks.ts`, `schema.ts` (Zod mirror of the contract).
- **Judging:** `analyze.ts`, `prompts.ts` (`PROMPT_VERSION`), `fastaVarden.ts`,
  `motivering.ts`, `siffrorKontroll.ts`.
- **Read-time assembly:** `assemble.ts` (final `AnalysisResult`; shared price
  core `byggPrisanalysUtanForening`), `prisdata.ts`, `prisjustering.ts`,
  `uppgiftsjamforelse.ts`, `sammanfattning.ts`, `refinansieringsflagga.ts`,
  `lokalfragor.ts`, `referensrantaHamtning.ts` (Riksbank SWEA).
- **`calc/`:** `prognosantaganden.ts` (every prognosis assumption),
  `avgiftsprognos.ts`, `sparbehov.ts`, `lokalrisk.ts`, `rantestress.ts`,
  `manadskostnad.ts`, `amortering.ts`, `ranteavdrag.ts`, `schabloner.ts`,
  `spann.ts`.
- **Cost and tooling:** `costGuard.ts` (prices per model, `STANDARD_MODELL`),
  `callMetrics.ts`, `korExtraktion.ts` (sequential run for the CLIs),
  `modellPerSteg.ts` and `inputFil.ts` (CLI helpers), `answerKey.ts`, CLIs
  `cli.ts` and `verifyAnswerKey.ts`. Golden request bodies in `__golden__/`,
  extraction fixtures in `__fixtures__/`.

### `src/server/` (server-only)

- `analysFn.ts`: the server functions and the **only** client-importable file
  (no module-scope values; see Gotchas).
- Analysis: `analys.ts` (create / status / result / preview), `register.ts`
  (register lookup, `PIPELINE_VERSION`, re-runs), `steg.ts` (job state machine
  on `rapport`), `stegLogg.ts`, `lagratInput.ts`, `vantskarmVardering.ts`
  (unadjusted valuation for the waiting screen).
- Price and reference data: `prisuppskattning.ts` (price check service),
  `postnummer.ts` (postcode hint, pure), `referensranta.ts` (daily cache of the
  reference rate; never throws).
- Identity and access: `kontext.ts` (device cookie + hashed IP + session →
  principal), `auth.ts` (Supabase Auth flows), `sessionCookies.ts`,
  `supabaseAuth.ts`, `principal.ts`, `behorighet.ts` (entitlement policy),
  `kvot.ts` (rate limits), `spend.ts` (daily spend cap).
- Saved items and register: `sparat.ts` (saved valuations/kalkyler/analyses,
  GDPR export; ownership in one helper `kravAgare`), `registerPublik.ts`
  (public register reads, BRF-level only).
- Ports and adapters: `portar.ts` (`Lager` / `Databas`), `kontoPortar.ts`,
  `supabase.ts`, `supabaseKonto.ts`; in-memory fakes in `__fakes__/` mirror the
  SQL.
- Other: `fel.ts` (error → buyer-safe Swedish), `env.ts`, `cache.ts` (legacy
  caches).
- `annons/`: Booli prefill (see "Listing data").
- `cli/`: `registerCli.ts`, `kontoCli.ts`, `analysCli.ts`, `verifyRls.ts`.
- `edge/build.ts`: bundles `steg.ts` for Deno.

### `supabase/functions/analys-steg/`

`index.ts` is hand-written Deno glue mirroring `supabase.ts`; it imports the
esbuild bundle `_bundle/steg.js` (gitignored). Also `reinvoke.ts` and
`effort.ts` with their two vitest files, the only tests outside `src/`.

## Pages

- `/`: landing page.
- `/analysera`: one form in two steps, shared state.
  - **Booli link** (above step 1): "Klistra in länk från Booli" + "Hämta
    uppgifter" → `hamtaAnnonsFn`. It only fills the form and never starts the
    Priskoll or an analysis. Found fields get the hint "Hämtat från Booli"
    ("Ändrat manuellt" after an edit; a geocoded postcode says OpenStreetMap);
    missing fields get "Fanns inte i annonsen, fyll i själv" and a warning
    border. The source goes into `PropertyInput.kalla` on both analysis paths.
  - **Steg 1, Priskoll:** the valuation without a PDF
    (`hamtaPrisuppskattningFn`), rate-limited. Fields: adress, boarea, rum,
    avgift, postnummer, våning, byggår, utgångspris (optional), hiss, balkong.
    Adress and byggår are required client-side only; the server schemas keep
    them optional so old saved valuations still open. Result:
    `analysera/PriskollResultat.tsx`. "Spara" (account) and re-open via
    `?sparad=<id>` (stored snapshot + "Räkna om med dagens modell");
    `?spara=vardering` finishes a draft after login.
  - **Postnummer help:** under the field, the area hint from the valuation
    tables (`hamtaPostnummerInfoFn`, debounced) and a link to PostNord's
    postcode search. No address geocoding: Nominatim gave wrong postcodes.
  - **Steg 2, Granska föreningen:** the PDF dropzone, or, with
    `?forening=<slug>` from a register page, "finns redan hos Binfo" via
    `skapaAnalysFranRegisterFn` (no PDF, no API call, loose quota only).
  - Required for the analysis: adress, boarea, våning, avgift, rum, postnummer,
    byggår. Without utgångspris the report shows the "Binfos värdering" variant
    and hides the asking-price rows.
  - Submits PDF + `PropertyInput` JSON as FormData to `skapaAnalysFn`, then
    goes to `/forhandsvisning/$analysisId`.
- `/forhandsvisning/$analysisId`: polls `hamtaStatusFn` every 5 s, then renders
  the full report (`hamtaResultatFn` + `AnalysRapport`). There is no paywall; a
  future payment belongs on the `ladda_upp_analys` entitlement, before the run.
- `/analys/$analysisId`: the same report for bookmarks and `/konto` links; any
  error redirects to `/forhandsvisning`.
  - **"Spara analysen"** on both report pages: `useSparaAnalys` +
    `SparaAnalysVy`, server `hamtaSparstatusFn` (`sparad` | `kan_sparas` |
    `ingen`), `forberedSparaAnalysFn`, `sparaAnalysFn`. Someone else's analysis
    shows nothing. No re-run, no API call.
- `/vardering`: 301 to `/analysera`, carrying `sparad` and `spara`.
- `/bolanekalkyl`: the calculator; all math in `src/lib/kalkyl/berakna.ts`.
  Search params `manadsavgift`, `rantekanslighet`, `pris`, `boarea`,
  `prisUppskattning`, `ingar`/`ingarEj`, `analys` (read once at mount), plus
  `sparad`/`spara`. Inputs reach the server only on an explicit "Spara" by a
  logged-in user. The main view stays simple; rate scenarios, KALP and the
  rules list live in a collapsed "Fördjupning" section, opened automatically
  when KALP inputs are non-default (`kalpArAndrad`). PDF/Excel export via
  `KalkylExport` (lazy, SSR-guarded).
- `/kopguide`: the buying guide (`lib/kopguide/steg.ts`). Progress is kept in
  localStorage `binfo:kopguide:v1` when logged out and in `kopguide_framsteg`
  when logged in, merged once per browser and account. `/konto` shows "X av 12
  steg klara. Nästa: …". `/guide` is a 301 to it.
- `/brf`, `/brf/omrade/$omrade`, `/brf/$slug`: the public register (BRF-level
  data only; cacheable; must never set cookies). `/brf/$slug` is a summary:
  name, fiscal year, grade, the nyckeltal with their status, the stored
  `betygMotivering` of the latest year. "Se hela analysen" goes to
  `/brf/$slug/analys/$ar` (`hamtaRegisterAnalysFn`, `no-store`, `noindex`),
  gated by the `se_registeranalys` entitlement.
- `/exempel`: static demo report (`AnalysRapport` over `sampleAnalysis`; the
  title comes from the sample's förening name).
- `/konto` and `/konto/{logga-in,skapa,glomt-losenord,bekrafta,nytt-losenord}`:
  accounts (`noindex`). `/konto/bekrafta` verifies only on a button press (mail
  scanners must not burn one-time tokens). `?till=` is sanitised.
- `/om-oss`: about page (team photo `public/bilder/om-oss.jpg`), linked from the
  footer only, never the main nav.
- `/integritet`: privacy policy, linked from the footer.
- `/sitemap.xml`: server route.
- **SEO:** SSR on every route. Register pages have real-figure titles and
  descriptions, canonical, og:*, JSON-LD (Organization + BreadcrumbList);
  `robots.txt` has a `Sitemap:` line; `public/og.png`
  (`scripts/genereraOgBild.mjs`). `/analys`, `/forhandsvisning`, `/konto*` are
  `noindex`. 404 and error pages are Swedish.

## The analysis pipeline

### 1. Upload: `skapaAnalysFn` → `skapaAnalys` (`src/server/analys.ts`, Worker)

1. `losKontext`: device cookie `binfo_enhet`, HMAC'd IP, and the Supabase Auth
   session (`kontextMedSession`) → principal.
2. Entitlement `ladda_upp_analys`.
3. Validation: Zod `PropertyInput`, SHA-256, `%PDF`, ≤ 25 MB, kill switch.
4. `extractPdfText` → `klassificeraTextlager`: `ok` | `saknas` (≥ 50 % of pages
   without text; scan path, ≤ 60 pages) | `trasigt` (garbled; normal path,
   measured better).
5. Daily spend cap (read-only), skipped for a free register hash hit.
6. Upload quotas: strict 5/device and 10/IP per day (refunded on exact hash
   hits) + loose 30/device and 100/IP per day (never refunded). IP only from
   `cf-connecting-ip`.
7. Register lookup (`register.ts`): `rapport_fil` hash hit → instant reuse;
   else local identity (Luhn orgnr + fiscal year + matching BRF name) → reuse;
   else a new `rapport` (stage `identifiering`, or `grundning` if identified).
   Quota is refunded when nothing new is paid for.
8. Upload `<hash>.pdf` (private bucket `arsredovisningar`, kept indefinitely)
   and insert the per-user `analys` row linked to the `rapport`.

### 2. Worker

pg_cron `binfo-tick` (every minute, 3 POSTs) → `analys-steg` → `korNastaSteg`
(`steg.ts`): claims a `rapport` (`claim_next_rapport_steg`, lease, ≤ 3 attempts
per stage; falls back to legacy `analys` rows), checks `pipeline_version`,
advances one stage, writes only under its lease (`uppdateraLeasadRapport`), and
reinvokes itself on success via `<PROJECT_URL>/functions/v1/analys-steg`
(`reinvoke.ts`; `req.url` is an internal address that refuses connections).

### 3. Stages on `rapport`

Each stage reserves and reconciles daily spend.

1. **`identifiering`:** Haiku 4.5 reads pages 1–3 → orgnr/year/name. A register
   hit marks this rapport `ersatt` and re-points its buyers (no spend after).
2. **`transkribering`** (scans only): pdf-lib 5-page chunks transcribed in
   parallel (Sonnet 5.5, ≤ 10 000 output tokens per chunk in the worker
   (`TRANSKRIBERING_MAX_OUTPUT_TOKENS_PER_CHUNK`, sized so 60 pages stay under
   the 15 kr ceiling; the library default of 16 000 applies to the `extract`
   CLI), 110 s deadline, at most 3 chunks per invocation because of the 2 s
   CPU limit, then reinvoke).
   Persisted per page in `sidtext` and reused across rapport rows of the same
   PDF while `TRANSKRIPTION_PROMPT_VERSION` is unchanged. Deterministic failures
   are terminal; hard ceiling 15 kr per report.
3. **`grundning`:** citations over the PDF (`page_location`) or over the
   transcription (custom-content `content_block_location` → page map). The
   prompt lists the seven nyckeltal first; a longer prompt otherwise sometimes
   skipped the whole flerårsöversikt.
4. **`extraktion`:** a text-only call over the grounding findings (citations and
   structured output can't be combined, hence two calls). JSON, Zod, one blind
   retry, then deterministic reconciliation (`tolkaNyckeltal` →
   `harledSkuldfriaNyckeltal` → `berikaNyckeltal` → `kontrolleraRimlighet`).
   - Scans are tagged `kalla: 'skannad'`, konfidens ≤ medel.
   - `sidreferenser.ts` verifies every cited excerpt against the page text
     (pdf.js, or `sidtext` for scans; skipped for `trasigt`): wrong page →
     corrected, not found → `osaker` + a question. Page refs tolerate
     private-use ligature gaps (Nabo PDFs).
   - Also extracted: förening addresses and fastighetsbeteckningar (cited),
     per-loan `lanebok.lan` (date, rate, rörlig by label or a reset ≤ 3 months
     after `balansdag`; `forfalloprofil` is derived in code), `rantekostnader`,
     `bostadsrattsyta`, `balansdag`, maintenance amounts/fund/allocation,
     `sparandeUttag`, `sparandeHistorik`, `lokaler`, `energiprojekt`.
   - **Building parts:** in Nabo/SBC "utfört underhåll" tables the years sit in
     their own column, so a citation never holds a row's year. Grounding writes
     the row's year before each quote, and `foregaendeRad` (prompts.ts) prefixes
     each finding's context with the last line of the preceding uncited block.
     Extraction keeps one item per byggdel and year, counts status lines ("Tak:
     Omlagt 1986") and maps utbytta elstigar → `el`.
     `genomfordaAtgarder[].omfattning` is `"byte" | "forlangning"` (absent =
     byte). An extension (relining 30 years; tak/fönster/fasad/el 10;
     `BYGGDEL_FORLANGNING_AR`, `docs/underhall-referens.md` §1c) only delays
     "eftersatt"; ventilation and hiss count every action as a replacement.
     Results still vary run to run on hard reports (Ingemar 8: 3/7–6/7).
   - When a rapport is done: `forening_adress kalla='rapport'` is written, the
     register area (`losRegisteromrade`) and slug are assigned, and
     `register_sammanfattning` is refreshed.
5. **`bedomning`:** judging over the extraction only (never sees buyer data;
   page refs must be a subset of the extraction's pages). The prompt gets
   Binfo's own "Fasta värden" (`fastaVarden.ts`: allowed letters, the seven
   nyckeltal, loan maturities with amounts and shares; "Värdeår (INTE byggår)")
   and must not compute numbers itself.
   - `kontrolleraBedomning` clamps the grade to the band the status counts allow
     (`tillatnaBetyg`: 0 svag/0 kritisk → A–C, 1 svag → B–C, ≥ 2 svag → C, any
     `kritisk` → C–E), logging every clamp.
   - `sakraMotivering` checks every number in `betygMotivering` against the
     extraction (`siffrorKontroll.ts`); on a clamp or mismatch it makes ONE small
     rewrite call (letter fixed, effort low, stage `motivering`); still wrong →
     a deterministic fallback. Never fails the stage.
   - Each question carries `varfor` (shown "Varför:") and an optional
     `svarssignal` ("Bra svar / varningssignal").
   - A dry assembly runs before the rapport is marked done. An
     `AssemblyValidationError` there is logged, not fatal: the rapport is
     shared, and the error surfaces only for that buyer's read.

BRF-level (shareable) = `rapport.extraction` + `rapport.judgement`. Buyer-level
(assembled per read) = `input`, `prisanalys`, `rantestress`, missing-data
questions, the fee-deviation question.

`PIPELINE_VERSION` = `p<PROMPT_VERSION>.i<IDENTITET_PROMPT_VERSION>.s<SCHEMA_MAJOR>`,
currently `p16.i1.s1`. `rapport.proveniens` defaults to `api`. Each stage has
pure `bygg*Request` / `tolka*Svar` functions; golden tests pin the request
bodies.

### 4. Reads

Reads re-assemble on every request from the rapport's extraction/judgement and
the buyer's `property_input`. Only results that parse with the current schemas
are served; older compatible versions are served exactly as stored, grade
included, with a note.

**Reads never re-run anything** (API money only on a user's request). A re-run
on the current version is queued only by an upload or a register request when
the report exists only at an older version, behind the spend cap and the strict
quota. Once done, every reader of that report gets the new one.

Assembly (`assemble.ts`) computes, with today's reference rate:
`avgiftsprognos`, the adjusted price (`prisanalys.justeringar` /
`justeradVardering`), the fee table, `uppgiftsjamforelse`, re-graded nyckeltal
statuses and `sammanfattning`. It drops model text claiming byggår is missing
when it is known. Old extractions get a degraded prognosis (maturity year only
→ 1 July). The date-sensitive code uses Stockholm time.

### 5. Retention

`binfo-retention` (daily, defined in `20261024120000_annons.sql`) blanks
`adress` / `postnummer` / `orgnr` and drops `kalla` in `property_input` after 12
months, and purges quota rows and `annons_cache` rows after 2 days. PDFs, the
register and BRF analyses are kept.

### Measured cost and time

`claude-sonnet-5-5`, effort `medium`, API time; production adds ~10 s per stage
for reinvokes.

| Report                          | API time                                     | Cost                                                                                   |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| Text report                     | 51–81 s API; 77 s upload→done on local stack | 1.98–3.82 kr, mean 3.2 (n=8). ~120k in / ~12k out tokens; grounding ≈ 62 % of the cost |
| Scanned report (16–34 pages)    | 80–113 s API; 185 s upload→done (34 p)       | 4.1–6.5 kr (transcription ≈ 0.105 kr/page)                                             |
| Register hit (same file or BRF) | < 1 s                                        | 0 kr                                                                                   |
| Identity call                   | ~2 s                                         | ~0.05 kr                                                                               |

Prompt caching is implemented but off by default (an isolated report costs
slightly more with it); `ANTHROPIC_PROMPT_CACHE=system` for bursts.
`costGuard.ts` prices: Sonnet 5/5.5 $2/$10, Haiku 4.5 $1/$5 per MTok, cache read
0.1×, USD→SEK 9.7 (unverified placeholder). The Message Batches API is not
used.

**Models:** one model per job (`rad.model`; CLIs read `ANTHROPIC_MODEL`).
Haiku 4.5 was rejected for transcription (wrong page markers). Claude Haiku 5.5
was measured (`docs/haiku-matning-2026-10-26.md`): cheaper (≈ 0.34 kr/report)
but less accurate and it overruns the 16k extraction cap, so Sonnet 5.5 stays.
CLI-only knobs: `ANTHROPIC_MODEL_BEDOMNING`, `ANTHROPIC_MAX_TOKENS_EXTRACTION`.

## From report to price: the fee prognosis

Spec: `docs/avgiftsprognos.md`, `docs/underhall-referens.md`,
`docs/DECISIONS.md`.

- **One channel.** The förening's economy changes the price only through the
  expected rise in the monthly fee. The grade never moves the price.
- **Components** (`calc/avgiftsprognos.ts`, `beraknaAvgiftsprognos`):
  savings gap, refinancing, unfunded maintenance, lokal risk, energy projects
  and decided fee increases → a flat kr/month via the flat's fee share
  (`manadsavgift × 12 ÷ årsavgifter`, `raknaAndel`). Every component text
  states its basis and the share.
- **Assumptions** all live in `calc/prognosantaganden.ts` (horizon,
  refinancing share, margin 0.58 pp, maintenance years, lokal risk, 3 %
  widening, 30 % guard, the OLS fee coefficient β synced to `metadata.json` by a
  test, reference-rate fallback).
- **Refinancing:** loans maturing within the horizon are priced (two phases).
  Matured loans get `fas: "forfallit"`: shown, never priced. For a report older
  than 18 months (`MAX_RAPPORTALDER_MANADER`), rörlig and undated loans are
  assumed refinanced too; only loans whose reset is still ahead are priced, at
  the report's rate, and the text says so. The flag and summary sentence come from
  `refinansieringsflagga.ts` over the same component.
- **Savings gap** (`calc/sparbehov.ts`): the target is the plan's own figure or
  the 300 kr/m² schablon moved 250–350 by building-part ages, on totalyta. The
  sparande is the average of up to four years. A positive gap splits into a
  deficit part (below zero, paid by the fee) and a borrowable part, borrowed
  while debt per m² stays under `SKULDTAK_KR_PER_M2` = 5 000; unknown debt →
  nothing borrowed. Cash flow is deliberately not a price input. The sparande
  status band (`benchmarks.ts`) is a separate number from this target.
- **Lokal risk** (`calc/lokalrisk.ts`, `lokalfragor.ts`): 100 % on a cited loss
  signal, 50 % for a lease ending without a cited renewal; at most three
  questions.
- **Price** (`prisjustering.ts`, `byggPrisjustering`): the adjusted price is
  the baseline plus β × rise × kr/m². Missing data widens only the low end.
- **Component price effects:** one function, `komponentPris` (exact factor
  `belopp ÷ −total`, rounding remainder once), feeds the card, the waterfall
  and the PDF.

### Consistency rules

Several places say the same thing; keep them in step.

- **Model text vs Binfo's numbers.** `rodaFlaggor`, `betygMotivering` and the
  model's questions are written once at judging (BRF-level, date-independent,
  from `fastaVarden.ts`). Everything date-aware is computed per read in
  `assemble.ts`, with `byggSammanfattning` last.
- **Statuses are re-graded on read** (`omgraderaNyckeltal` in `assemble.ts`
  and `registerPublik.ts`); stored grades stay untouched. Band values are not in
  any prompt, but `BENCHMARKS[id].kommentar` is (`FORBEHALL` in `prompts.ts`),
  so changing a kommentar or the informativ list needs a `PROMPT_VERSION` bump.
- **The seventh nyckeltal** (årsavgifternas andel av rörelseintäkter) is
  `riktning: "informativ"` → status `okant`. When it has a value it is shown
  unrated ("Ingen bedömning") in the report, the PDF and the register
  (`analysisView.ts`); other figures with status `okant` are hidden.
- **Valuation display:** one rounding rule (`avrundaVardering`), one span
  (`vardespann`, ±10 % of the shown value, `VARDESPANN_PROCENT` in
  `analysisView.ts`) and `lageMotVardespann` decide "i linje med modellen". The
  kalkyl prefill uses the shown value.
- **Byggår:** extraction falls back to värdeår when the report has no byggår.
  The buyer's year is used when given; the report's year only fills a gap.
  `PropertySummary` shows a badge next to Byggår ("Avviker" + "Årsredovisningen:
  X (du angav Y)", "Osäkert", "Från årsredovisningen", "Värdeår enligt
  årsredovisningen"; `byggarMarkor` in `analysisView.ts`), mirrored as a suffix
  in the PDF. The contract still allows `bekraftat`, which is never produced.

## Valuation

- **Model v3.1** (card `ml/artifacts/valuation-v3.1/MODEL_CARD.md`, delta to
  `valuation-v3/MODEL_CARD.md`; version history in `ml/README.md`): LightGBM on
  log(kr/m²), trained on ~5 000 Svensk Mäklarstatistik sales in Stockholms
  kommun (January–August 2026). Features: boarea, rum,
  fee/m², våning, byggår, hiss, balkong, area, postcode effect. Training data has
  a monthly fee but **no BRF identity and no BRF debt**.
- **Flow:** `ml/cleaning.py` → `train_valuation_v3.py` / `valuation_v3_lib.py`
  → `train_valuation_v31.py` / `valuation_v31_lib.py` (postcode encoding) →
  `ml/artifacts/valuation-v3.1/` → `npm run build:vardering-data` →
  `src/lib/vardering/data/*.data.ts` (generated; never hand-edit).
- **Runtime** (`src/lib/vardering/`, server-only): `vardera.ts` (entry),
  `tree.ts` (tree evaluator), `features.ts`, `tackning.ts` (tiering),
  `drivare.ts`, `budpremie.ts`, `postnummer.ts`, `kommunKodning.ts`, `data.ts`,
  `types.ts`.
- **Coverage:** Stockholms kommun → area model (CV MAPE 9.6 %); rest of the län
  → general relationships × the kommun's 12-month average kr/m²; outside the län
  → × the national average with a disclaimer first. Confidence is never `hog`;
  outside Stockholms kommun always `lag`.
- **Areas** (`data/derived/postnummer_omrade.csv`, built by
  `ml/mapping/build_postnummer_omrade.py` from Stockholms stad's 117 stadsdel
  polygons + OSM/GeoNames points): 13 areas: Östermalm, Vasastan-Norrmalm,
  Södermalm, Hägersten-Liljeholmen, Enskede-Skarpnäck, Bromma-Västerled,
  Kungsholmen, Farsta-Vantör, Hässelby-Vällingby, Spånga-Kista,
  Brännkyrka-Skärholmen, Essingen, Centrala Stockholm (Gamla stan, Riddarholmen,
  Skeppsholmen). They are model features: renaming them means retraining. 182
  Stockholm postcodes have no area and get "Okänt". The OSM-derived map's ODbL
  share-alike status is unresolved.
- **Postcode effect:** shrunk toward the 4-digit neighbourhood (k=5,
  k_group=5); an unseen postcode takes its neighbourhood's effect. A
  residual-based effect (v3.2) was tested and rejected (worse CV, unstable on
  sparse postcodes).
- **Factor rows ("drivers")** are not derived from LightGBM: one OLS on
  log(kr/m²) over all training sales → `effects.json` →
  `effects.data.ts`. `drivareForInput` selects only `signifikant` effects,
  never `=okant`, never `EXCLUDED_EFFECT_IDS` (`build_year+10`, `boarea+10`);
  hiss/balkong only when the input says `nej` in Stockholm. `balcony=nej` is not
  significant (n = 10), so no balcony row shows. The report no longer shows
  per-flat driver rows; "Så har vi räknat" holds the model and the span.
- **Value names:** "Liknande lägenheter" = the unadjusted model value
  (`externVardering`); "Binfos värdering" = the value adjusted for the
  förening's economy (`justeradVardering`, falls back to the baseline). The
  90 % interval (`vardera.ts`) is computed but not shown.
- **Debt share:** the full analysis adds the flat's debt share (skuldsättning
  per m² bostadsrättsyta × boarea) as a comment, never applied to the value. It
  is hidden on the web and printed in the PDF.
- The data period is `DATA_PERIOD` in `ml/train_valuation.py`, parsed into the
  manifest; the UI formats it (`formatDataperiodLang`, "januari–augusti 2026").
- The price check alone can be recomputed offline with
  `byggPrisanalys(input, new ModellPrisdatakalla())`.

## Listing data (Booli)

- **Path:** "Hämta uppgifter" → `hamtaAnnonsFn` → `hamtaAnnons`
  (`src/server/annons/hamta.ts`): kill switch `ANNONS_HAMTNING` →
  `kontrolleraAnnonsUrl` (https, `booli.se`, `/annons/<id>` or `/bostad/<id>`,
  canonical URL = cache key) → `annons_cache` (24 h) → no source on? (`avstangd`,
  no quota taken) → entitlement `hamta_annons` → quota → source(s) → cache.
- **Sources** (`AnnonsLeverantor` in `kallor.ts`; the answer says which one
  was used, `metod: "api"` or `"sida"`):
  1. **Booli REST API** (default; `booliApi.ts` + pure mapping
     `booliApiTolkning.ts`). `/annons/<id>` → `listings/{id}` → on 404
     `sold/{id}`. `/bostad/<id>` (a residence id, a different number space) →
     `listings?residenceId` → `listings?residenceId&upcomingSale=1` →
     `sold?residenceId` (latest sale; older than 365 days → no utgångspris or
     avgift); the answer must echo `searchParams.residenceId`. Then
     `areas?lat&lng` for the postcode. Signed per call with Web Crypto. Needs
     `BOOLI_CALLER_ID` + `BOOLI_PRIVATE_KEY` (a student key, use approved by
     Booli). An expired key logs `[annons] booli-api nyckel avvisad` and the
     buyer fills in by hand.
  2. **Listing page** (`booliSida.ts`: fetch + `tolkaBooli` (RSC `Listing`
     object + JSON-LD, never visible HTML) + optional Haiku fallback
     `llmFallback.ts` + Nominatim `geokod.ts` when the postcode is missing).
     Only with `ANNONS_SIDHAMTNING=on`; the production Worker is
     Cloudflare-challenged there.
- **The answer only fills the form** (`src/lib/annons/formular.ts`). Fields
  (`ANNONS_FALT`): boarea, antalRum, manadsavgift, postnummer, vaning, byggar,
  utgangspris, hiss, balkong, adress, ort; context: stadsdel, forening,
  maklarUrl, koordinater. Hiss/balkong: the API's explicit `0` → "nej", except
  on a sparse listing (≥ 2 of rent/floor/byggår/listPrice missing), where it
  stays unknown; the page only ever gives "ja". A sold listing fills
  utgångspris with its `listPrice`, never the sold price.
- Provenance goes into `PropertyInput.kalla` (`AnnonsKalla`, `typ: "booli"`)
  and is blanked by the 12-month retention. Attribution "Uppgifter från Booli"
  on `/analysera` and a line in "Källor och metod" (web `RapportSlut.tsx`, PDF
  `buildKallor`, helper `booliKallaRad`).
- **Sold at the same address** (`docs/plans/salt-i-huset.md`): for a
  `/bostad/<id>` link, every flat sold at the same address in the last 10 years
  (`sold?residenceId`, tagged "Den här lägenheten", + a 200 m box filtered on the
  exact address); 5 rows, then "Visa alla (n)"; PDF the 5 newest. Shown after
  "Så har vi räknat" in the report and after "Vad värderingen bygger på" on
  `/analysera`. `hamtaForsaljningarFn` → `src/server/annons/forsaljningar.ts`,
  cached 24 h under `booli-salda:v2:<id>`, same entitlement and quota. Display
  only, never a valuation input.
- **What downstream uses:** the valuation uses boarea, antalRum, manadsavgift,
  postnummer (the most important locator), vaning, byggar, hiss, balkong;
  missing vaning/byggar/avgift are model-handled. The BRF analysis uses the
  buyer's input only for the fee share, the fee-deviation question and the debt
  share.
- Details: `docs/booli.md`, `docs/plans/booli-api.md`,
  `docs/research/booli-sold.md`. Booli's Cloudflare challenges Node's `fetch`,
  so `npm run dev` can't fetch listing pages; curl and workerd can.

## Bolånekalkyl and domain rules

Current as of October 2026; trust this over training data.

- **Rules registry** (`src/lib/kalkyl/regler.ts`) is the single source for every
  calculator rule, shown in the UI, PDF and Excel with source and date. Rule
  types: Regel / Referensvärde / Antagande / Uppskattning. Change a rule there,
  bump `REGELVERSION` (currently `"2026-10-28"`), and the Excel parity test must
  still pass. A test fails on "TODO", "placeholder" or "ägarbeslut" in rule
  text.
- **`KalkylUnderlag` v2** = `pris` + `kontantinsats` (lån = pris − insats); v1
  rows and drafts migrate. Fee items have two states (ingår / ingår ej); no
  ranges.
- **Amortisation** (Lag (2026:226) om begränsning av bostadskrediter §7, in
  force 2026-04-01; FI's FFFS 2016:16, 2016:33 and 2020:3 ceased 2026-03-31):
  LTV > 70 % → 2 %/yr; > 50 % up to and incl. 70 % → 1 %/yr; ≤ 50 % → none, on
  the highest credit amount since the last valuation. Nyproduktion: the lender
  may waive it for up to 5 years for the first buyer (§10). The skärpta
  amorteringskravet is abolished. Bolånetak 90 % at purchase (§4), 80 % for an
  increased loan (§5). The 50/70 % thresholds live in `calc/amortering.ts`.
- **Skuldkvot** is information only; there is no statutory income cap. The 5×
  bank cap is an assumption.
- **Ränteavdrag** (inkomstår 2026): 30 % on interest up to SEK 100 000 per
  person per year, 21 % above. The cap is per person, so the number of
  borrowers matters. Unsecured loans get no deduction from 2026. One
  computation (`skatt2026.ts`) feeds the total and "Tillbaka i deklarationen".
- **KALP** (`levnadskostnader.ts`): Konsumentverket "Hushållskostnader 2026";
  kalkylränta 7 % is an editable assumption. Konsumentverket's household costs
  already include hushållsel, vatten, internet and hemförsäkring, so only värme
  is added. Verdict = sign + amount, no threshold words.
- **Drift schablons** (`regler.ts`, read by `calc/schabloner.ts`; sources in
  `docs/driftschabloner-kallor.md`): hushållsel and hemförsäkring =
  Konsumentverket 2026 by persons (1–7); värme 21 kr/m² boarea (Nils Holgersson
  2026, Stockholm, incl. varmvatten); vatten 135 kr per person (45.61 m³/person
  × 35.54 kr/m³); värme and vatten only when "Ingår ej"; bredband 349 kr is
  Binfo's estimate. The report's "I avgiften" shows all five items.
- **Seven statutory nyckeltal** (BFNAR 2023:1, from FY2023). Extraction must
  produce all seven: årsavgift/m² bostadsrättsyta; årsavgifternas andel av
  rörelseintäkter; skuldsättning/m² totalyta; skuldsättning/m²
  bostadsrättsyta; sparande/m² totalyta; räntekänslighet; energikostnad/m²
  totalyta. They usually sit on 1–2 pages (förvaltningsberättelse /
  flerårsöversikt).
- **Thresholds** are product decisions in `BENCHMARKS.md`, mirrored in
  `benchmarks.ts`. Negative sparande is graded svag, not kritisk.
- **Räntekänslighet** (interest-bearing debt ÷ annual fee income) is how many
  percent fees rise per percentage point of rate increase; the rate stress uses
  it directly. A genuinely missing value never fails the analysis: only the
  rate stress is disabled (`rantekanslighetProcent: null`) and the gap becomes a
  question.
- A debt-per-m² figure with an unclear basis (e.g. "Lån per kvm bostadsyta") is
  reported as skuldsättning per m² bostadsrättsyta.
- **Debt-free förening:** if the report shows no interest-bearing debt, cited,
  then räntekänslighet and both skuldsättning/m² = 0 (`source: 'berakning'`).
- Lagfart/pantbrev: houses only. Board approval of membership: bostadsrätter
  only.
- Never present a statistical association as causation. An effect whose sign
  contradicts the obvious direction is replaced by the broader estimate or
  omitted.

## Database and identity

Supabase; details in `SUPABASE.md` (partly older than the code; the code wins).

- **Tables:**
  - Base: `analys` (per-buyer job rows), `extraktion_cache` / `analys_cache`,
    `spend_day`.
  - Register: `forening` (+ `slug`, `registeromrade`, `omrade_kalla`),
    `forening_slug` (renamed-slug history), `rapport` (shared, versioned job and
    result; partial unique on `(orgnr, rakenskapsar, pipeline_version)` and on
    `(pdf_hash, pipeline_version)` = the concurrency locks), `rapport_fil`,
    `sidtext`, `forening_adress` (`kalla='rapport'` from the report,
    `'anvandare'` from the buyer's postcode; the register area is decided report
    address > buyer postcode), `register_sammanfattning` (one row per BRF),
    `pg_trgm` index on `namn`.
  - Accounts: `principal`, `behorighet` (empty), `kvot` + `ta_kvot`,
    `sparad_vardering`, `sparad_kalkyl`, `kopguide_framsteg`.
  - Other: `annons_cache`, `referensranta` (on `KontoDatabas`; without the table
    the read falls back to the configured rate).
- **Migrations** (`supabase/migrations/`, all applied in production): init,
  lan_underlag_nullable, anonymise_property_input, retention_fix, register,
  konto, konto_v3, register_v3, annons, referensranta, kopguide. Never edit an
  applied migration; add a new one.
- **Access:** RLS on with zero policies; functions `security invoker`. The
  register and konto functions are execute-only for `service_role`; the
  init-migration functions were never revoked from `anon` (RLS still blocks
  them). The browser has no Supabase client; every read and write goes through
  server functions with the secret key.
- **Cron jobs:** `binfo-tick`, `binfo-reaper`, `binfo-retention`,
  `binfo-keep-alive`. Vault holds `project_url` and `automations_key`.
- **Identity:** Supabase Auth, server-side only (httpOnly `binfo_sa` /
  `binfo_sr` cookies). `losKontext` validates/refreshes the session and maps
  the auth user to a `typ='konto'` principal. The device's anonymous principal
  is merged once on first login; logout rotates `binfo_enhet`. Without
  `PROJECT_PUBLISHABLE_KEY`, everything behaves anonymously.
  - Password change needs a 15-min signed reset marker (`binfo_aterst`) or the
    current password; account deletion needs the password.
  - A logged-out analysis reaches the account either by the password-login
    merge, or (new account confirmed by e-mail link) by a 7-day HMAC-signed
    marker `binfo_spara` set on "Spara analysen", then a compare-and-set move of
    that one `analys` row (`flyttaAnalys`).
  - The `analysisId` UUID is the read capability for analyses.
  - Local Auth config and Swedish templates: `supabase/config.toml`,
    `docs/epostmallar/`; hosted setup: `docs/auth-setup.md`.
- **Actors:** anonymous visitor (device cookie only), anonymous device
  principal (created on first upload), account principal. Accounts have no
  roles. **There is no admin UI**: admin means the CLIs plus the env kill
  switches and the Supabase/Lovable dashboards.
- **Entitlements** (`behorighet.ts`): `prisuppskattning`, `ladda_upp_analys`,
  `full_rapport`, `se_registeranalys`, `hamta_annons` are checked; `pdf_export`
  is defined but unchecked (exports are client-side). All are granted to
  everyone today; only saving needs an account.
- **Quotas** (`kvot.ts`, UTC windows): upload 5/device + 10/IP per day (strict,
  refundable) and 30/100 (loose); Priskoll 60/IP per hour (saving a valuation
  also takes one); Booli 20/device + 60/IP per hour; login 10/IP + 5/e-mail per
  15 min; sign-up 5/IP per hour; reset 3/e-mail + 10/IP per hour; register
  reads 300/IP per hour; 200 saved valuations and 200 saved kalkyler per
  account.

## Where UI copy lives

- **Report:** `AnalysRapport.tsx` + `components/rapport/*` (Föreningen / Priset
  / Avgiften framåt / Inför visningen / Källor och metod). Text helpers in
  `src/lib/analysisView.ts`; grade titles in `lib/betygVy.ts`; price helpers in
  `lib/prisVy.ts` (`vanligtBud` = utgångspris × (1 + median bid premium), mkr
  formatting); "på/i" for valuation areas in `lib/omradeText.ts`. Component
  texts come from `avgiftsprognos.ts`. The closing "Sammanfattning" data is
  computed (`sammanfattning.ts`) but not rendered.
- **Price section:** "Justerat för väntad avgiftshöjning", the collapsed "Så har
  vi räknat" (`<details>`), the rate slider with "Dagens avgift" / "Förväntad
  avgift" tabs (`Rantestress`, texts in `rantestressVy`; the PDF keeps a
  table). The source paragraph is `varderingsKallaText`.
- **Waiting screen:** `Pagar` in `AnalysStatus.tsx` ("Din analys pågår", "Det tar
  några minuter", a scan-only insert when `textlager === 'saknas'`). Six design
  steps mapped from the pipeline stage (`designSteg` / `designAndel` in
  `analysStatusVy.ts`): identifiering/transkribering/grundning → 1, extraktion
  → 2, bedomning → 3; steps 4–6 run at read time and are never shown "Klart".
  `AnalysStatusSvar` carries `adress`, `foreningNamn`, `utgangspris`,
  `liknande` while queued/running. Error copy: `STEG_TEXT` etc. in
  `analysStatusCopy.ts`.
- **Priskoll** (step 1): `src/routes/analysera.tsx` and `lib/priskollVy.ts`.
- **PDF export:** its own view model in `src/components/pdf/viewModel.ts`.
  Change web copy → check the PDF too.
- **Web vs PDF:** the web report shows at most two red flags
  (`toppRodaFlaggor(…, 2)`) and hides the section when there are none; the PDF
  lists every flag, with "Inga röda flaggor identifierade." when empty. The web
  shows only questions with `ursprung === "analys"` in `Fragor`.
- **Account copy:** wrong current password → "Fel nuvarande lösenord.", wrong
  delete password → "Fel lösenord."; dialog busy text per action; logout and
  deletion land on "/"; no leaked-password claims (Supabase free plan).

## Design system

Source of truth: the "BINFO REDESIGN" canvas
(https://claude.ai/code/artifact/914d592f-7ae8-45ef-8234-fc3390006acd, its 13
artboards only). Artboards hold example data and placeholders; every value on a
page comes from real data.

- **Visual boundary:** don't change visual design (styling, layout, colours,
  typography, spacing, animations, images, the `ui/binfo` kit) unless the owner
  asks. New UI is built from the kit and tokens; anything that needs polish
  goes on a "For Lovable to polish" list. The PDF layout is ours to design,
  kept simple and consistent with the site.
- **Tokens** live in `src/styles.css` (`:root` + `@theme inline`, oklch with the
  hex in a comment). Never hard-code a hex in a component; add a token. Palette:
  navy `#0A2F5E` (primary, headings, logo), link `#1C4FA3`, ink `#111418`,
  text-2 `#30363D`, muted `#4B535C`, page `#F4F6F9`, card `#FFFFFF`, border
  `#DCE1E8`, divider `#EEF1F5`, input `#B9C2CE`, tint `#E8EEF8`, track
  `#E9EDF2`, success `#1E7A4D`/`#E6F4EA`/`#1E6B3A`, warning pill
  `#FFEDD5`/`#9A3412`, notice `#FFF7E6`/`#F3D9A4`/`#5C3800`, danger
  `#B42318`/`#FDECEA`/`#991B1B`.
- **Grades A–E are coloured:** A `#14532D`, B `#1E7A4D`, C `#B45309`, D
  `#B42318`, E `#8A1C12`, white serif letter. One component (`GradeBadge`, plus
  `GradeScale` for the 5-step bar) for every place a grade shows.
- **Type:** Source Serif 4 (600) for h1/h2, key figures and the logo; Inter
  (400/500/600) for everything else. Eyebrows: Inter 13 px, 600, uppercase,
  0.08em, link colour. Body 16 px, line-height 1.5. The PDF self-hosts Inter
  and Source Serif 4 (TTF + OFL in `public/fonts`; the IBM Plex / Libre
  Baskerville files are used by `scripts/genereraOgBild.mjs`).
- **Shape and spacing:** cards 10 px radius, 1 px border, white; inputs and
  buttons 6 px radius, min-height 48 px (44 px secondary); pills 999 px; grade
  badges 8 px. Container max 1200 px, 32 px gutter (16 px under 640 px).
- **Focus:** a visible 2 px link-colour outline with 2 px offset on every
  interactive element. Contrast ≥ 4.5:1.
- **Logo:** house outline (navy) with a green check mark + "Binfo" in Source
  Serif 4 (`Logo`).
- **Copy:** never say anything is free ("gratis") or optional ("valfritt");
  describe what the user gets. Copy that states a fact about data handling must
  match `/integritet`.
- **Contact:** `KONTAKT_EPOST` (`src/lib/kontakt.ts`) drives the footer
  "Kontakt" link, "Hittar du ett fel?" and the failure screens; when `null` they
  are hidden.
- **Owner-hidden elements** stay in the DOM with `hidden`: the valuation
  provider line (`AnalysRapport.tsx`, web only), the debt-share row
  (`RapportPris.tsx`, web only), the Hus/Bostadsrätt toggle on `/kopguide`.
  "Dina senaste analyser" is not rendered at all
  (`VISA_SENASTE_ANALYSER = false`). Do not unhide them.

## Conventions

- All user-facing text is in Swedish. Code, comments, identifiers and commits
  are in English. Many older pipeline/server comments are in Swedish; match the
  surrounding file.
- **Unknown ≠ false.** Use `Tristate = 'ja' | 'nej' | 'okant'`, never
  `boolean | null`.
- **Estimates are labelled.** `source: 'schablon'` renders distinct from
  `'arsredovisning'` / `'anvandare'`. A guess must never look like a fact.
- **Every extracted figure carries its page reference.** No citation, no
  display. Page numbers come from the API (citations), never from the model.
  For scans the citation points into Binfo's transcription (block → page map),
  tagged `kalla: 'skannad'`.
- SEK as integers; areas in m² with one decimal.
- **Never invent domain numbers** (thresholds, benchmarks, schablons). Cite a
  source or mark `// TODO: unverified placeholder`.
- **Model output is untrusted.** Zod-validate everything. Handle scanned PDFs,
  missing figures and malformed responses explicitly. A silent empty analysis
  is the worst failure; a visible failure is fine.
- **`PROMPT_VERSION`** (`prompts.ts`) is part of the cache key and of
  `pipeline_version`. Bump it whenever any prompt text changes
  (`prompts.test.ts` enforces this). A bump needs the web app and the Edge
  Function deployed close together, otherwise in-flight jobs fail with
  `versionskonflikt`. A model switch keeps serving existing results; a bump
  marks them as older (served with a note; re-run only on a user's request).
- **Tests first** for anything with a correct answer (extraction, calculators,
  valuation).
- Before claiming done, run `npm run typecheck`, `npm test` and `npm run lint`
  (and `npm run dev` for UI), and report the real output.
- Ask when a spec or domain rule is ambiguous; don't guess.

## Commands

```
npm install
npm run dev                 # localhost:8080
npm run build               # vite build (Cloudflare Worker output in .output/)
npm run lint                # eslint . (baseline: 0 errors, 9 react-refresh warnings)
npm run typecheck           # tsc --noEmit (src/ + configs; not scripts/ or supabase/functions/)
npm test                    # vitest run
npm run format              # prettier --write . (printWidth 100)
npm run preview | build:dev # vite preview / development-mode build
npm run extract -- <pdf> [input.json]      # pipeline standalone incl. scans (REAL spend)
npm run verify-extraction -- <dir>         # score against the answer keys (spend); VERIFY_SAVE_RESULTS=<dir> keeps results + underlag; VERIFY_FROM_RESULTS=<dir> = free; VERIFY_ONLY=<orgnr,…>
npm run analys -- <pdf> <input.json>       # LIVE Supabase job + spend
npm run register -- list|inspect|invalidate|backfill-legacy|rerun   # LIVE register admin
npm run konto -- radera|exportera <principalId>                     # LIVE GDPR erasure/export
npm run verify-rls                         # LIVE: RLS with secret vs publishable key
npm run build:edge / deploy:edge           # bundle / deploy analys-steg (deploy needs owner OK)
npm run build:vardering-data               # regenerate src/lib/vardering/data from ml artifacts
npm run build:register-data                # regenerate src/lib/register/data from data/derived/postnummer_stadsdel.csv
node --import tsx scripts/monteraOm.ts <underlag.json>      # re-assemble a saved run for free
node --import tsx scripts/hamtaBooliFixtures.ts [--spara]   # re-fetch the Booli page fixtures with curl
node --env-file=.env.local --import tsx scripts/testaBooliApi.ts       # try the Booli API with the local key
node --env-file=.env.local --import tsx scripts/hamtaBooliSalda.ts [fran] [till] [areaId]   # Booli sold flats → data/raw/booli/ (gitignored)
node --import tsx scripts/seedLokaltRegister.ts   # LOCAL stack only: seed /brf with test BRFs
./scripts/v2-lokalt.sh [--nollstall]      # whole app on a LOCAL Supabase stack (Docker); real Claude cost
cd ml && .venv/bin/pytest                  # ML tests
```

- **Sandbox:** `npx tsx` fails with EPERM inside the Claude Code sandbox; use
  `node --import tsx <file.ts>`. `.env.local` is invisible in the sandbox and
  sets `ANTHROPIC_MODEL=claude-sonnet-5`, which overrides the code default: set
  `ANTHROPIC_MODEL=claude-sonnet-5-5` for measurements.
- **Dev check:** after touching `analysFn.ts`, run `npm run dev` and open a page
  in a browser; import-protection errors only show there, not in
  `npm run build`.
- **Workerd:** `npm run build`, then from `.output/server` run
  `npx wrangler dev --config wrangler.json --compatibility-date <date>` (a date
  the cached workerd supports) with a temporary `.dev.vars` pointing at the
  LOCAL stack only; delete it afterwards.
- **Migrations:** no npm script. Local: `supabase db reset --local` (used by
  `v2-lokalt.sh`). Production: `npx supabase@2.117.0 db push` (owner OK only).
- **Regenerating `/exempel`:** write `{ "input": PropertyInput }` (strict), run
  `EXTRACT_SPARA_UNDERLAG=underlag.json ANTHROPIC_MODEL=claude-sonnet-5-5 npm run -s extract -- <pdf> input.json > out.json`,
  paste as `export const sampleAnalysis: AnalysisResult = …`. Check the judging
  text against the PDF before accepting a run (a run once wrote "nästan 90 %"
  where the report said 74 %). Tests in `src/components/pdf/*.test.ts*` and
  `Prisrimlighet.test.tsx` assert the sample's content.
- **Lockfiles:** `bun.lock` + `bunfig.toml` belong to Lovable;
  `package-lock.json` is the local npm lockfile and is load-bearing
  (`edge/build.ts` pins the Deno `npm:` specifiers from it). Keep both in sync
  when adding a dependency.

## Environment variables

Names only; values live in `.env.local`, Lovable Secrets or Supabase secrets.
`.env.example` lists them.

- **Web app** (every server function needs the full env):
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (code default `claude-sonnet-5-5`),
    `MAX_COST_PER_ANALYSIS_SEK` (default 5; the `extract` CLI uses 25 for
    scans), optional `ANTHROPIC_EFFORT_GROUNDING|EXTRACTION|JUDGING` (default
    `medium`).
  - `PROJECT_URL`, `PROJECT_SECRET_KEY` (also derives the IP-hash key),
    `PROJECT_PUBLISHABLE_KEY`, `MAX_DAILY_SPEND_SEK`, `ANALYSIS_KILL_SWITCH`.
  - Booli: `ANNONS_HAMTNING` (`off` = kill switch), `BOOLI_CALLER_ID` +
    `BOOLI_PRIVATE_KEY` (absent = API skipped), `BOOLI_API` (`off`),
    `ANNONS_SIDHAMTNING` (`on` = page fetch fallback), `ANNONS_LLM_FALLBACK`
    (`on` = Haiku fallback). Web app only.
- **Edge Function:** the same, minus `ANTHROPIC_MODEL` (the model comes from the
  job row), plus `AUTOMATIONS_KEY`. These live in **Supabase** secrets,
  separate from Lovable's: rotating `ANTHROPIC_API_KEY` means updating
  `.env.local`, Lovable Secrets AND Supabase secrets.
- **CLI/dev only:** `SUPABASE_ACCESS_TOKEN`, `ANTHROPIC_PROMPT_CACHE`
  (`off`/`system`/`on`), `ANTHROPIC_EFFORT`, `ANTHROPIC_EFFORT_TRANSKRIBERING`,
  `PRISKALLA` (`modell`/`tom`/`demo`), `VERIFY_FROM_RESULTS`,
  `TRANSKRIPTION_CACHE`.
- Supabase vars are named `PROJECT_*` because Lovable and Supabase both refuse
  secret names starting with `SUPABASE_`.
- Validated in `src/server/env.ts` (web app) and inline in
  `analys-steg/index.ts` (`lasEnvInline`). Never `VITE_`-prefix a secret;
  `env.ts` throws if one is present.

## Gotchas

- **`analysFn.ts` must have no module-scope values.** Its handler bodies are
  stripped from the client bundle, its top level is not: a module-level
  `const x = serverThing()` keeps a server-only import in the client graph and
  `npm run dev` shows an import-denied overlay (the build still passes).
- **Edge glue duplication.** `analys-steg/index.ts` mirrors `Env` / `Databas` /
  row mapping by hand (Deno has no `@/` alias). Every new `Databas` method used
  by `steg.ts` goes into `index.ts`, `supabase.ts` and `__fakes__/lager.ts`; a
  test enforces that the Edge glue has every method.
- **Worker writes are leased.** Stage results go through
  `uppdateraLeasadRapport` (only while `running` under the claimed lease), so a
  slow worker never resurrects an invalidated or reaped rapport.
- **Edge limits.** Free plan: 150 s wall clock, 2 s CPU per invocation → one
  stage per invocation. A cut-off invocation holds its lease for 300 s.
- **pdf.js detaches buffers.** Always pass `bytes.slice()` to `extractPdfText`.
- **Lovable publish = production deploy of the web app.** When code on `main`
  needs a new migration or Edge Function version, apply those first (`db push`,
  `deploy:edge`), then publish. Jobs created by an older web app fail with
  `versionskonflikt` until both sides match.
- **Lovable formats differently.** Its editor reflows code wider than the
  repo's prettier, so `npm run lint` shows prettier errors after a Lovable
  edit. Fix with `npx eslint --fix <files>` in a separate commit, only when
  Lovable isn't editing those files.
- **Local UI without a backend.** There is no mock mode. Every server function
  needs the server env; without it `/forhandsvisning/<id>` falls back to
  "hittades inte". `.env.local` points at **production**, so never create
  analyses with `npm run dev`. Use `./scripts/v2-lokalt.sh` (local Supabase) or
  render `Pagar` with fake props in a test.
- **Lazy client-only libraries** (`@react-pdf`, `exceljs`): reach them only via
  a dynamic `import()` guarded by `if (import.meta.env.SSR) return;` in the
  click handler. Without the guard they land in the Worker bundle (2.71 → 1.70
  MB gzipped with it; Cloudflare's free-plan limit is 3 MB).
- **Cacheable public pages must not set cookies.** `/brf*` and `/sitemap.xml`
  send `Cache-Control: public, s-maxage=…`; their server functions skip
  `losKontext` on purpose. Never call a session/kontext function from their
  loaders.
- **Dev server ports.** `npx vite dev --port <n>` works; parallel agents should
  use their own port.
- **Slow checks.** Cold `npm test`, `npm run lint` and `npm run typecheck` each
  take 1–2+ minutes; use a long timeout or run them in the background.
- **Playwright** is not a dependency; cached Chromium builds live in
  `~/Library/Caches/ms-playwright`.

## Known limitations

- Entitlements grant everything; no MFA, no social login, no e-mail change UI
  (template and `/konto/bekrafta` handling exist), no resend of the
  confirmation mail. Pages that need login check it client-side after
  hydration (SSR shows "Laddar…").
- The public register is filled only by user uploads.
- Scans over 60 pages are refused (product limit).
- PDFs are kept indefinitely (register). Delete them via the Storage API, never
  with SQL (Storage refuses direct deletes). The privacy text still needs a
  stated basis for keeping PDFs that name board members (public documents).
- `hamtaStatusFn` has no ownership check (the UUID is the capability) and, while
  a job runs, returns the buyer's address and asking price for the waiting
  screen.
- `skapaAnalys` hashes and parses the whole PDF before taking the upload quota.
- "Recent analyses" storage: the box is hidden, but `sparaAnalys` still writes
  each created/opened analysis id + BRF name to localStorage
  (`binfo:senaste-analyser`). Whether to keep it is undecided.
- Every 5 s status poll reads `rapport` rows with `select *` (large jsonb); fine
  at today's volume.
- Legacy in the database: `slapp_rapport_steg` (unused except by
  `verifyRls.ts`), the columns `analys.lan_underlag` / `grundtext` (still mapped,
  unused). `radera_analys` is still called by `radera_min_analys`.
- Volontären `antalLokaler` is still missed (1 vs null).
- The xlsx export has no cached formula values (`fullCalcOnLoad`): Excel and
  Numbers compute on open, but Quick Look shows empty cells.
- Accessibility gaps in the kit: `Toggle` has no `aria-pressed`; `Field` has no
  `autocomplete`/`name`.
- `SiteNav` is a flat wrapping row with no mobile menu.
- SEO: `/sitemap.xml` omits `/integritet`; `/brf` (index) has no JSON-LD;
  `/exempel` has no nav or footer link.

## How work is organised

- **Supervisor + subagents.** The main session owns plan, order, decisions,
  integration and commits. Subagents (`.claude/agents/`: `codebase-explorer`,
  `data-and-model`, `frontend-state`, `pdf-pipeline`, `reviewer`; run on Sonnet)
  get self-contained briefs. They never edit overlapping files concurrently,
  never commit, never run `git stash` / `checkout` / `reset` on the shared tree,
  never change shared contracts (they report back instead), and stop rather
  than guess. The supervisor reviews every diff and re-runs the checks.
- **Lovable sync.** The frontend is also edited in Lovable, which pushes to
  `main`. `git pull` before starting; never edit the same files in Lovable and
  Claude Code at the same time; don't rename or restructure frontend files
  beyond what a task needs; never rewrite pushed history. Publishing in Lovable
  is a manual step by the owner.
- **Deploys** (`supabase db push`, `deploy:edge`) and pushes to `main` need the
  owner's explicit OK. `.claude/settings.json` puts them, and the live CLIs, in
  the "ask" list.
- Every paid API run is logged in the private repo's API test log.

## Don't touch

- `src/routeTree.gen.ts` (generated).
- Applied migrations in `supabase/migrations/`. Add a new migration instead.
- `.env*` files and lockfiles by hand. Never commit secrets.
- **The server boundary.** `src/server/` and `src/lib/vardering` are
  client-forbidden, via `importProtection` in `vite.config.ts` and
  `no-restricted-imports` in `eslint.config.js`. Both carve out
  `src/server/analysFn.ts` and nothing else; never widen either.
- **`src/types/analysis.ts`.** Changing it breaks both sides at once, so stop
  and flag before editing. Never widen `Forhandsvisning`.

## Reference docs

- `README.md`: public overview.
- `docs/DECISIONS.md`: product decisions with dates.
- `PIPELINE.md`: pipeline design rationale. `SUPABASE.md`: schema, job
  orchestration, live verification. Both are partly older than the code.
- `BENCHMARKS.md`: nyckeltal thresholds.
- `docs/avgiftsprognos.md`, `docs/underhall-referens.md`: fee prognosis and
  maintenance references.
- `docs/driftschabloner-kallor.md`: sources for the running-cost schablons.
- `docs/booli.md`, `docs/plans/booli-api.md`, `docs/plans/salt-i-huset.md`,
  `docs/research/booli-sold.md`: listing data.
- `docs/auth-setup.md`, `docs/epostmallar/`: accounts and e-mail.
- `docs/bolagsverket.md`, `docs/haiku-matning-2026-10-26.md`: research notes.
- `ml/artifacts/valuation-v3.1/MODEL_CARD.md` (+ `valuation-v3/MODEL_CARD.md`),
  `ml/REGIONAL_DESIGN.md`: the valuation model.

When a reference doc and the code disagree, the code wins. Fix the doc.
