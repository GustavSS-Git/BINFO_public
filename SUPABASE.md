# Supabase: database, storage and job orchestration

How Binfo persists analyses and runs the analysis pipeline on Supabase:
schema, SQL functions, access model, cron, the job queue, spend and quota
guards, retention, the local stack and how changes are applied. The SQL in
`supabase/migrations/` and the code in `src/server/` are the source of truth;
when this file disagrees with them, the code wins and this file gets fixed.

## Architecture

The web app (TanStack Start, built by Lovable for Cloudflare Workers) only
does fast work: validate an upload, store the PDF, write rows, read status and
results. Anything that calls the model runs in Supabase:

```
skapaAnalys (Worker)          rapport row (queued)
  upload <hash>.pdf  ───────►     │
  analys row → rapport            ▼
                         pg_cron binfo-tick (every minute, 3 POSTs)
                                  │
                                  ▼
                         Edge Function analys-steg (Deno)
                           korNastaSteg: claim one row, run ONE stage,
                           write under the lease, reinvoke itself
```

- **Postgres is the queue**, `pg_cron` the scheduler, one Edge Function the
  worker. No other vendor; Lovable's Cloudflare account accepts no Queue/D1/R2
  bindings.
- **One model call per invocation.** Edge Functions on the Free plan get
  150 s wall clock and 2 s CPU per invocation; a full analysis takes longer,
  so the job is split into stages and each invocation advances one.
- **The browser has no Supabase client.** Every read and write goes through
  server functions holding the secret key. Supabase Auth is used server-side
  only (httpOnly cookies, see "Identity and accounts").

Code map:

| File                                         | Role                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/server/analys.ts`                       | `skapaAnalys`, `skapaAnalysFranRegister`, `hamtaStatus`, `hamtaResultat`                    |
| `src/server/register.ts`                     | Register lookup, upload linking, versioning, re-runs, register summary                      |
| `src/server/steg.ts`                         | `korNastaSteg`: the stage state machine (bundled into the Edge Function)                    |
| `src/server/spend.ts`, `kvot.ts`             | Daily spend guard, rate limits                                                              |
| `src/server/portar.ts`, `kontoPortar.ts`     | `Lager` / `Databas` / `Filarkiv` / `KontoDatabas` ports                                     |
| `src/server/supabase.ts`, `supabaseKonto.ts` | Supabase adapters for those ports                                                           |
| `src/server/__fakes__/`                      | In-memory fakes mirroring the SQL (all server tests run against them)                       |
| `supabase/functions/analys-steg/`            | Edge Function glue (`index.ts`), `reinvoke.ts`, `effort.ts`, generated `_bundle/` (ignored) |
| `src/server/edge/build.ts`                   | esbuild bundle of `steg.ts` for Deno                                                        |
| `src/server/cli/`                            | `registerCli.ts`, `kontoCli.ts`, `analysCli.ts`, `verifyRls.ts`                             |

## Migrations

All 11 are applied in production. Never edit an applied migration; add a new
one. Each later migration that redefines a function or the retention job says
so in its header.

- `20260913105304_init.sql`: `pg_cron`, `pg_net`; `analys`, `extraktion_cache`,
  `analys_cache`, `spend_day`; bucket `arsredovisningar`; `claim_next_steg`,
  `slapp_steg`, `binfo_reaper`, `reservera_spend`, `avstam_spend`,
  `radera_analys`; the cron jobs.
- `20260913140646_lan_underlag_nullable.sql`: `analys.lan_underlag` nullable,
  commented dead.
- `20260924120000_anonymise_property_input.sql`,
  `20261008000000_retention_fix.sql`: earlier retention commands (superseded).
- `20261009120000_register.sql`: `forening`, `rapport`, `rapport_fil`,
  `sidtext`, `forening_adress`, `analys.rapport_id`; `claim_next_rapport_steg`,
  `slapp_rapport_steg`, the upsert RPCs; redefines `claim_next_steg`,
  `binfo_reaper`, `radera_analys`.
- `20261009120100_konto.sql`: `principal`, `behorighet`, `kvot`,
  `analys.principal_id`; quota and principal RPCs, `radera_principal`.
- `20261013120000_konto_v3.sql`: `sparad_vardering`, `sparad_kalkyl`;
  `sakerstall_konto_principal`, `lista_mina_analyser`, `radera_min_analys`.
- `20261013120100_register_v3.sql`: `rapport.proveniens`, `forening` slug and
  area columns, `forening_slug`, the `pg_trgm` index, `register_sammanfattning`
  and its functions.
- `20261024120000_annons.sql`: `annons_cache`; owns the current
  `binfo-retention` command.
- `20261025120000_referensranta.sql`: `referensranta`.
- `20261028120000_kopguide.sql`: `kopguide_framsteg`; the current
  `sla_samman_principal` and `radera_principal`.

**Rollback scripts** live in `supabase/rollback/<migration>.down.sql` for every
migration from `register` on. They are never applied automatically: run one by
hand, on the owner's command, only after the code that uses the objects has
been reverted. Several destroy data (stated in each header). Order matters:
`konto.down` before `register.down` (`behorighet` references `rapport`);
`register.down` copies finished register results back into the legacy caches
so finished buyers keep their analysis.

## Schema

Conventions for every table: RLS on with zero policies; the server uses the
secret key, which bypasses RLS. Tables added from `konto_v3` on also have their table
privileges revoked from `anon` and `authenticated` (defence in depth).

### Jobs and results

**`analys`**: one row per buyer request.

- `id` (uuid) is the `analysisId` and the read capability: anyone holding it
  can read that report.
- `property_input` (jsonb, the buyer's `PropertyInput`), `pdf_hash`,
  `pdf_path`, `model`, `prompt_version`, `created_at`.
- `rapport_id` (nullable FK): the shared `rapport` that carries the work. All
  new rows have it; for them `status`/`stage` are written once
  (`queued`/`uploaded`) and never read again, because status derives from the
  rapport.
- `principal_id` (nullable FK, `on delete set null`): the owning principal.
- Legacy job columns (only for rows without `rapport_id`): `status`
  (`analys_status`), `stage` (`analys_stage`: uploaded/extracting/judging/
  complete), `grundtext`, `lease_until`, `attempts`, `error_code`,
  `error_message`, `cost_sek`, `started_at`, `finished_at`, and the dead
  `lan_underlag`.

**`rapport`**: one analysis of one årsredovisning, shared by every buyer.

- Identity: `orgnr` (FK `forening`) + `rakenskapsar`, both or neither
  (`rapport_identitet_hel`). Without identity a rapport is reusable by hash
  only.
- `pipeline_version` (`p<PROMPT_VERSION>.i<IDENTITET_PROMPT_VERSION>.s<SCHEMA_MAJOR>`,
  `PIPELINE_VERSION` in `register.ts`), `model` (stored, deliberately not part
  of any key), `textlager` (`ok` | `saknas` | `trasigt`), `proveniens`
  (`api` default | `batch` | `offline-session`).
- Job: `status` (`rapport_status`: queued, running, done, failed, ersatt),
  `stage` (`rapport_stage`: identifiering, transkribering, grundning,
  extraktion, bedomning, klar), `lease_until`, `attempts`, `started_at`,
  `finished_at`.
- `pdf_hash`: the bytes it runs on (a `rapport_fil` key; not an FK, because
  the rapport is created before its file row).
- Results: `grundtext` (grounding output, nulled once extraction consumes it),
  `extraction` (`ExtractionResult`), `judgement` (`AnalysJudgement`). Both are
  Zod-validated on every read.
- `error_code` / `error_message` (buyer-safe Swedish; plus `ogiltigforklarad`
  for invalidated rows), `cost_sek`, `cache_read_tokens`,
  `cache_write_tokens`.
- `ersatt_av`: set with status `ersatt` (`rapport_ersatt_har_mal`), the
  rapport this one turned out to duplicate.

The two **concurrency locks** are partial unique indexes over live rows
(status not `failed`/`ersatt`), so failing or invalidating a rapport frees its
slots. `supabase.ts` recognises a violation (SQLSTATE 23505) by index name.

| Index                      | Columns                                   | Settles                                                                                 |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `rapport_identitet_uniq`   | `(orgnr, rakenskapsar, pipeline_version)` | Two rapporter claiming the same report and version                                      |
| `rapport_fil_version_uniq` | `(pdf_hash, pipeline_version)`            | Two live rapporter on the same bytes (incl. concurrent re-runs of an identity-less one) |

Other indexes: `rapport_klaim_idx` (partial, claimable rows only),
`rapport_orgnr_ar_idx`, `rapport_pdf_hash_idx`, `rapport_created_at_idx`.

**`rapport_fil`**: one row per byte version (sha256) of a report:
`pdf_hash` (PK), `rapport_id`, `pdf_path`, `sidor`, `bytes`, `uppladdad`. The
primary key settles two concurrent uploads of the same bytes.

**`sidtext`**: per-page transcription of a scanned report:
`(rapport_id, sida)` PK, `text`, `kalla`
(`transkribering:v<TRANSKRIPTION_PROMPT_VERSION>`), `on delete cascade`.

### Register

- **`forening`**: one row per BRF. `orgnr` PK (CHECK `^\d{6}-\d{4}$`),
  `namn`, `forst_sedd`, `senast_sedd`, `slug` (unique, `<namn>-<orgnr>`),
  `registeromrade`, `omrade_kalla` (`rapport_adress` | `import` |
  `anvandare`). GIN trigram index on `namn` for search.
- **`forening_slug`**: earlier slugs of a BRF; the register answers them with
  a 301 to the current slug.
- **`forening_adress`**: where a BRF is. `kalla = 'rapport'` rows hold the
  report's own addresses; `kalla = 'anvandare'` rows hold a buyer's postnummer
  (+ kommun code, område) and never a street address (CHECK). Unique
  `nulls not distinct (orgnr, postnummer, adress, kalla)`, so Postgres ≥ 15 is
  required (`config.toml` pins 17). The register area is decided from report
  addresses first, buyer postnummer second.
- **`register_sammanfattning`**: one row per BRF for the public register: the
  latest fiscal year's servable rapport (preferring the current pipeline
  version), its seven nyckeltal as columns, `betyg`, `analysdatum`, and copies
  of name/slug/area. A plain table maintained one BRF at a time by
  `uppdatera_register_sammanfattning`, not a materialised view.

### Accounts, entitlements and limits

- **`principal`**: who a request belongs to. `typ` `anonym` (one per device
  cookie `binfo_enhet`, `enhet_id` unique, created on the first expensive
  action) or `konto` (`auth_user_id` unique FK to `auth.users`).
  `sammanslagen_till` records a merge and is kept single-level.
- **`behorighet`**: entitlement rows (`formaga`, `kalla` gratis/kop/
  prenumeration, optional `rapport_id`, `giltig_till`). Empty: the policy in
  `src/server/behorighet.ts` grants everything today.
- **`kvot`**: fixed-window counters, PK `(nyckel, fonster_start)`. Keys are
  `<handling>:enhet:<device id>`, `<handling>:ip:<HMAC of IP>` or
  `<handling>:epost:<HMAC of e-mail>`; raw IPs and addresses are never stored.
- **`sparad_vardering`**, **`sparad_kalkyl`**: items an account chose to save
  (`input`, the server-computed result or summary, model or rules version,
  optional `etikett` ≤ 120 chars). Kept until the user deletes them or the
  account; exempt from the 12-month anonymisation.
- **`kopguide_framsteg`**: one row per principal, `klara text[]` (≤ 20
  elements, each `[a-z]{2,20}`, enforced by a CHECK; step ids are validated in
  the app).

### Spend and caches

- **`spend_day`**: `(day pk, cost_sek, runs)`, the daily API spend in
  Stockholm days. `runs` counts reservations (model-calling steps), not jobs.
- **`annons_cache`**: `(url pk, svar jsonb, hamtad)`. Booli prefill answers
  keyed by canonical listing URL, and the "sold at this address" lists under
  `booli-salda:v2:<id>`. Read as stale after 24 h, purged after 2 days.
- **`referensranta`**: `(serie pk, datum, procent, hamtad)`, the reference
  rate for the fee prognosis, refetched once per Stockholm day. Read through
  `KontoDatabas`; without the table the read falls back to the configured
  rate.
- `extraktion_cache`, `analys_cache`: legacy, see "Legacy".

## SQL functions

All are `security invoker` (the only caller holds the secret key, so
`definer` would add an escalation path for nothing). Functions from the
register migration on pin `search_path = public` and are revoked from
`public, anon, authenticated` and granted to `service_role`. The init
functions were never revoked from `anon`; RLS still blocks what they touch.

Queue and spend:

- `claim_next_rapport_steg(p_lease_sekunder = 300)`: atomically claims the
  oldest claimable rapport (`for update skip locked`), sets `running`, bumps
  `attempts`, sets the lease.
- `binfo_reaper()`: fails `analys` and `rapport` rows with `attempts >= 3` and
  no live lease.
- `reservera_spend(dag, belopp, tak)` and
  `avstam_spend(dag, reserverat, faktiskt)`: atomic reserve-then-reconcile of
  the daily cap.

Register:

- `registrera_forening(orgnr, namn)`: upsert; bumps `senast_sedd`, a non-null
  name wins.
- `registrera_forening_adress(...)`: upsert on `forening_adress_uniq`,
  coalescing kommun and område.
- `satt_forening_omrade(orgnr, slug, omrade, kalla)`: sets slug and area,
  keeps the old slug in `forening_slug`; null arguments leave columns alone.
- `register_nyckeltal(extraction, id)`: one key figure from a stored
  extraction.
- `uppdatera_register_sammanfattning(orgnr, pipeline_version)`: recomputes one
  BRF's summary row; deletes it when no done rapport is left.

Accounts and quotas:

- `kvot_fonster_start(sek)`, `ta_kvot(nyckel, sek, max)`,
  `aterlamna_kvot(nyckel, sek)`: UTC-aligned windows, an atomic take (a refused
  take changes nothing), give one back.
- `sakerstall_principal(enhet_id)`: insert-or-touch the device's anonymous
  principal (follows a merge).
- `sakerstall_konto_principal(auth_user_id, enhet_id)`: the account's
  principal, race-safe; merges the device's unmerged anonymous principal once.
- `sla_samman_principal(fran, till)`: merge; re-points `analys`, `behorighet`
  and saved items, unions köpguide progress.
- `radera_principal(id)`: GDPR erasure of a principal and everything merged
  into it; returns counts.
- `lista_mina_analyser(principal)`: the account's analyses (status, stage and
  grade from the rapport; address; price), at most 500.
- `radera_min_analys(principal, analys)`: deletes one own `analys` row through
  `radera_analys`; never touches the rapport.

Legacy: `claim_next_steg`, `slapp_steg`, `slapp_rapport_steg`, `radera_analys`
(see "Legacy").

## Access model

- **Keys.** `PROJECT_SECRET_KEY` (`sb_secret_…`) is used by every server
  path and bypasses RLS. `PROJECT_PUBLISHABLE_KEY` is used only by the Auth
  flows (`supabaseAuth.ts`); without it the app behaves anonymously. The
  legacy JWT keys are disabled on the project. Neither key ever reaches the
  browser, and `src/server/env.ts` throws on any `VITE_`-prefixed variable.
- **RLS.** On for every table, zero policies: `anon` and `authenticated` see
  and write nothing. `npm run verify-rls` proves it against the live project.
- **Ownership** of saved items and account analyses is enforced in the server
  (`kravAgare` in `sparat.ts`) and inside the statements themselves
  (`radera_min_analys`, and `flyttaAnalys`'s compare-and-set on
  `principal_id`).
- **Server boundary.** `src/server/` is import-protected from the client
  (Vite `importProtection` + ESLint `no-restricted-imports`); only
  `analysFn.ts` is client-importable.

## Storage

- Private bucket **`arsredovisningar`** (created by the init migration).
  Objects are content-addressed: `<sha256>.pdf` at the bucket root, so a report
  uploaded by twenty buyers is stored once. `skapaAnalys` always uploads and
  tolerates "already exists".
- **PDFs are kept indefinitely** so the register can re-run a report on a
  version change. Nothing deletes them automatically.
- Delete objects only through the Storage API (`Filarkiv.ta_bort`), never with
  SQL: Supabase Storage's `protect_objects_delete` trigger refuses a direct
  `delete from storage.objects`, and inside a cron command that error rolls
  back the whole transaction.
- Upload limits are enforced in `skapaAnalys` before storing: `%PDF` magic
  bytes, ≤ 25 MB, kill switch, and for scans ≤ 60 pages.

## Cron jobs and Vault

| Job                | Schedule     | Does                                                                    |
| ------------------ | ------------ | ----------------------------------------------------------------------- |
| `binfo-tick`       | every minute | Three `net.http_post` calls to `<project_url>/functions/v1/analys-steg` |
| `binfo-reaper`     | every 5 min  | `binfo_reaper()`                                                        |
| `binfo-retention`  | 04:30 daily  | See "Retention and erasure"                                             |
| `binfo-keep-alive` | 04:17 daily  | A GET against the project's own REST gateway (see below)                |

Times are pg_cron's (UTC). The keep-alive is deliberately independent of the
tick, so disabling the tick while debugging never puts the Free-plan project
on a path toward being paused.

Vault holds two secrets read by these jobs: `project_url` and
`automations_key`, sent as the `apikey` header. The Edge Function compares
that header with its own `AUTOMATIONS_KEY` secret, which must hold the same
value.

## Job orchestration

### Upload: `skapaAnalys` (`analys.ts`) and `kopplaUppladdning` (`register.ts`)

Checks run in this order; every refusal before the quota leaves no side
effects:

1. Entitlement `ladda_upp_analys`; Zod `PropertyInput`.
2. SHA-256 of the original bytes; `%PDF`; ≤ 25 MB; kill switch
   (`ANALYSIS_KILL_SWITCH=on` refuses everything).
3. Text layer (`klassificeraTextlager`, `src/lib/analysis/textlager.ts`):
   `saknas` when ≥ 50 % of pages have < 20 characters (scan path, refused
   above 60 pages); `trasigt` when the layer reads as glyph soup (score > 0.6;
   recorded, runs the normal path); else `ok`.
4. Daily spend cap, read-only (`kontrolleraDagligtTak`). Skipped when the hash
   already maps to a done, parseable rapport at the current version, which
   costs nothing.
5. Upload quota (strict + loose, see "Quotas"); then the principal is created
   or touched.
6. Upload `<hash>.pdf`, then link (`kopplaUppladdning`):
   1. **Hash** → `rapport_fil` → its rapport (following `ersatt_av`, at most 10
      hops): servable at the current version → reuse (`ateranvand`); running
      at this version → wait on it (`vantarPaRapport`); otherwise (older
      version, unparseable, failed) join a live current-version run of the
      same report or queue one on these bytes (`koaOmkorning`). A done but
      unparseable rapport at the CURRENT version would hold both slots
      forever, so it is marked `failed`/`ogiltigforklarad` automatically
      (`frigorTrasigPlats`).
   2. **Local identity** (`identifieraLokalt`, free; Luhn-checked orgnr +
      fiscal year + BRF name): a current-version register hit with BOTH names
      known and alike (`namnLiknar`) → new `rapport_fil` row, linked. A name
      unknown on either side, or two different names, means no reuse.
   3. **New rapport** at `grundning` (local identity) or `identifiering`
      (none), with a 120 s setup lease so no worker claims it before its file
      row exists. A lost race on either unique index or on the `rapport_fil`
      PK links the loser to the winner and deletes its unreferenced rapport.
7. Insert the `analys` row (with `rapport_id`, `principal_id`), register the
   buyer's postnummer for the BRF (best effort), and refund the strict quota
   when nothing new is paid for (reuse or wait reached through the exact
   hash). Any throw after the quota was taken refunds strict and loose and
   rethrows; `analysFn.ts` returns only a buyer-safe message.

`skapaAnalysFranRegister` (a buyer starting from `/brf/<slug>`, no PDF)
creates the same `analys` row. A report stored at the current version is
linked for free (loose quota only); one stored only at an older version queues
a re-run on the stored PDF behind the spend cap and the strict quota.

### Stages on `rapport`

```
identifiering ──(register hit)──► status 'ersatt', ersatt_av = hit (buyers re-pointed)
     │
     ├─(textlager 'saknas')─► transkribering ─┐
     ▼                                        ▼
grundning ─► extraktion ─► bedomning ─► klar (status 'done')
```

| Stage            | Reservation     | What it does                                                                                                                                        |
| ---------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identifiering`  | 0.3 kr          | Haiku reads pages 1–3 for orgnr/year/name; a register hit (same name rule) marks this rapport `ersatt`. Never fails the job (see below)             |
| `transkribering` | 0.15 kr × pages | Scans only: 5-page chunks transcribed in parallel, saved per page to `sidtext`                                                                      |
| `grundning`      | 3 kr            | Citation-grounded reading of the PDF, or of the transcription for scans; stores `grundtext`                                                         |
| `extraktion`     | 1 kr            | Structured JSON over `grundtext`, Zod, deterministic reconciliation, page-reference check; nulls `grundtext`                                        |
| `bedomning`      | 1.5 kr          | Judging over the extraction only; stores `judgement`, runs a dry assembly with the first buyer's input, marks `done`/`klar`, refreshes the register |

Reservations are deliberately rounded up and reconciled to the real cost after
the call. Pipeline details (prompts, reconciliation, grade clamping) are in
`CLAUDE.md` and `PIPELINE.md`.

### Claim, lease and attempts

- `korNastaSteg` first calls `claim_next_rapport_steg`; only when no rapport
  is claimable does it fall back to the legacy `analys` queue.
- The **lease is 300 s**, longer than the 150 s invocation ceiling, so a
  second tick never claims a row whose model call may still be running. A
  cut-off invocation therefore holds its row for up to 300 s.
- **Every worker write is leased** (`uppdateraLeasadRapport`: only while
  `status = 'running'` and `lease_until` equals the claimed lease). A stage
  that finishes after an admin invalidate, a reaper sweep or a re-claim drops
  its result instead of resurrecting the row; spend is still reconciled.
- **Attempts are per stage.** A successful stage resets `attempts` to 0 and
  sets the row back to `queued` without a lease. A failure re-queues while
  `attempts < 3`, else marks `failed`. `binfo_reaper` fails rows stuck at 3
  attempts with no live lease.
- **Deterministic errors are terminal** where a retry would pay for the same
  wrong answer (e.g. a truncated transcription, bad page markers, the
  transcription cost ceiling).
- **A refused spend reservation** (daily cap or kill switch) is not the job's
  fault: the row is re-queued with the attempt given back and error fields
  untouched.
- **`sidtext` writes are not leased.** A transcribed page is paid-for output of
  the same bytes and is kept even if the worker lost its lease; the write
  never touches the `rapport` row.

### Version guard

Immediately after a claim, before any spend, `rapport.pipeline_version` must
equal the running worker's `PIPELINE_VERSION`. A mismatch fails the rapport
with `versionskonflikt` (which frees its slots). The web app stamps the
version at upload and the Edge Function checks it, so the two must be deployed
close together whenever `PROMPT_VERSION` changes. The model is not part of the
version: a model switch keeps serving existing results.

### Reinvoke

When a stage succeeds and leaves more to do, `korNastaSteg` calls the
`reinvoke` hook. The Edge Function wires it to a fire-and-forget
`POST <PROJECT_URL>/functions/v1/analys-steg` with the same `apikey` header
(`reinvoke.ts`, kept alive with `EdgeRuntime.waitUntil`). Inside the runtime
`req.url` is an internal address that refuses connections, so the public
gateway URL is required. Reinvoke is only a speed-up: the minute tick picks up
anything it misses. With it, stages chain about a second apart.

### Identity stage

- A deterministic outcome (no identity, invalid or truncated answer, cost cap,
  refusal) continues at once without identity.
- A transient one (Anthropic 429/5xx/529, network, unknown) is retried like
  any stage and continues without identity after the third attempt.
- A rapport without identity is reusable by hash only; it can still pick up an
  identity from its own extraction later (Luhn- and name-checked).

### Scanned reports (`transkribering`)

- `pdf-lib` splits the PDF into 5-page chunks; at most **3 chunks per
  invocation** (`MAX_CHUNKAR_PER_ANROP`, `spend.ts`), because more logged the
  CPU soft limit. Remaining chunks: progress is saved, `attempts` reset, stage
  stays `transkribering`, and the function reinvokes.
- **Output cap per chunk: 10 000 tokens** in the worker
  (`TRANSKRIBERING_MAX_OUTPUT_TOKENS_PER_CHUNK`, `spend.ts`). The library
  default `STANDARD_MAX_OUTPUT_PER_CHUNK` (16 000, `transkribering.ts`) applies
  only to callers that don't pass one, such as the `extract` CLI.
- **Deadline 110 s** (`STANDARD_DEADLINE_MS`): in-flight chunk calls are
  aborted, finished pages stay saved, and the next attempt continues.
- **Ceiling 15 kr per report** (`MAX_TRANSKRIBERING_SEK` = 60 pages ×
  0.25 kr), counted over all invocations and attempts via `rapport.cost_sek`.
  The pre-flight sums each chunk's worst case from its real `countTokens`.
- **Reuse:** a rapport without `sidtext` first copies the pages of the newest
  other rapport with the same `pdf_hash` and the current `kalla`, so a
  version-bump re-run transcribes nothing.
- `grundning` for a scan first checks that `sidtext` covers every page;
  otherwise it fails terminally (`scanned_pdf`) instead of grounding on
  partial text. Figures from scans are tagged `kalla: 'skannad'` with
  confidence at most `medel`.
- `SKANNADE_RAPPORTER_AKTIVA` in `register.ts` is a code-level brake: `false`
  refuses scans at upload again.

### When a rapport is done

`uppdateraRegisterForOrgnr` (best effort, never fails the stage) writes the
report's own addresses as `forening_adress kalla='rapport'`, decides slug and
register area, and calls `uppdatera_register_sammanfattning`. A dry-assembly
`AssemblyValidationError` (one buyer's input) does not fail the shared
rapport: it is logged and surfaces only on that buyer's read.

### Reads

- **Reads never queue anything** and never call the model. A re-run is queued
  only by an upload or a register request.
- `hamtaStatus` derives everything from the linked rapport. The UI's
  `AnalysStage` union stays small: identifiering/transkribering/grundning →
  `uploaded`, extraktion → `extracting`, bedomning → `judging`, klar →
  `complete`; the real stage is `rapportSteg`.
- `hamtaResultat` serves (`valjLasbarRapport`) the newest done rapport for the
  same report at the current version; else the linked one if its stored
  extraction and judgement parse with the running code, exactly as stored and
  with the note "Analysen gjordes med en tidigare version av Binfo."; else
  nothing (the UI shows status instead). A newer analysed fiscal year adds a
  second note.
- The result is **assembled on every read** from the stored extraction and
  judgement plus the buyer's `property_input` and today's reference rate. No
  finished `AnalysisResult` is stored, so threshold changes re-grade old
  reports for free.

## Spend guard

- `MAX_COST_PER_ANALYSIS_SEK` (default 5) caps one model run;
  `MAX_DAILY_SPEND_SEK` caps the day; `ANALYSIS_KILL_SWITCH=on` refuses
  before any reservation is attempted.
- **Reserve, then reconcile** (`spend.ts`): before a model call,
  `reservera_spend` atomically adds the estimate only if the day stays under
  the cap; after it, `avstam_spend` swaps the estimate for the real cost.
  `reservera_spend` first inserts today's row if missing and then runs one
  gated update, so the day's first reservation is checked like every other.
- A `Reservation` object makes sure each step attempt reconciles exactly once.
- Days are Stockholm days (`Europe/Stockholm`), not UTC.

## Quotas

`ta_kvot` windows are fixed and UTC-aligned (a day resets at 00:00 UTC).
Limits are product decisions in `src/server/kvot.ts` (and
`registerPublik.ts`, `sparat.ts`):

| Action                      | Limit                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Upload, strict              | 5 per device, 10 per IP per day; refunded when the upload is served or joined via the hash |
| Upload, loose               | 30 per device, 100 per IP per day; never refunded                                          |
| Priskoll (valuation)        | 60 per IP per hour (device key without an IP)                                              |
| Booli prefill / sold list   | 20 per device, 60 per IP per hour                                                          |
| Login                       | 10 per IP, 5 per e-mail per 15 min                                                         |
| Sign-up                     | 5 per IP per hour                                                                          |
| Password reset              | 3 per e-mail, 10 per IP per hour                                                           |
| Public register reads       | 300 per IP per hour                                                                        |
| Saved valuations / kalkyler | 200 of each per account (a count, not a window)                                            |

The client IP comes only from `cf-connecting-ip`, HMAC'd with a key derived
from `PROJECT_SECRET_KEY`; without it only the device limits apply. When
several limits are taken together, the first refusal gives back every use
taken in that call.

## Retention and erasure

`binfo-retention` (04:30 UTC daily, defined by `20261024120000_annons.sql`):

- `analys.property_input` older than **12 months**: `adress`, `postnummer`,
  `orgnr` set to `""` (the schema requires strings, so the report still opens)
  and `kalla` (the Booli listing URL) removed.
- `kvot` windows older than **2 days** deleted.
- `annons_cache` rows older than **2 days** deleted.

Not touched: PDFs, `rapport`, `rapport_fil`, `sidtext`, the register, the
legacy caches (none name a buyer), saved items and `kopguide_framsteg` (kept
until the user deletes them or the account), `spend_day`, `referensranta`.

Erasure paths:

- **Account deletion** (`/konto`, password required) and
  `npm run konto -- radera <principalId>` call `radera_principal`: the
  principal and everything merged into it, their `analys` rows, `behorighet`,
  saved items, köpguide progress and device-keyed `kvot` rows. IP-keyed rows
  can't be tied to a principal and expire in 2 days. The CLI also deletes the
  Supabase Auth user. `npm run konto -- exportera <principalId>` prints the
  GDPR export.
- **"Ta bort från min lista"**: `radera_min_analys` deletes one own `analys`
  row. If `radera_analys` reports an unreferenced PDF (possible only for a
  legacy row), the server logs it and leaves deletion to the owner via the
  Storage API.

## Identity and accounts

- Supabase Auth runs server-side only, with httpOnly cookies `binfo_sa` /
  `binfo_sr`. `losKontext` validates or refreshes the session and maps the
  auth user to a `typ='konto'` principal (`sakerstall_konto_principal`).
- A password login (and any later session request) on a device whose
  anonymous principal is not merged yet merges it into the account, once.
  Confirming a new account by e-mail link deliberately does not merge and
  rotates `binfo_enhet`; a logged-out analysis then reaches the account via a
  7-day HMAC-signed `binfo_spara` marker and a compare-and-set update of that
  one `analys` row (`flyttaAnalys`). Logout also rotates `binfo_enhet`.
- Local Auth config and Swedish e-mail templates: `supabase/config.toml`
  (e-mail confirmations on, `site_url` `http://localhost:8080`) and
  `docs/epostmallar/`. Hosted setup: `docs/auth-setup.md`.

## Edge Function `analys-steg`

- **Auth:** `verify_jwt = false` (`config.toml`), so the `apikey` check
  against `AUTOMATIONS_KEY` in `index.ts` is the entire auth boundary.
- **Bundle:** `npm run build:edge` bundles `src/server/steg.ts` with esbuild
  into `_bundle/steg.js` (gitignored). `@anthropic-ai/sdk`, `unpdf` and
  `pdf-lib` stay external as `npm:<pkg>@<version>` pinned from
  `package-lock.json`, which makes that lockfile load-bearing.
- **Hand-written glue:** `index.ts` cannot import the repo's `@/` modules, so
  it carries its own minimal env reader (`lasEnvInline`) and `Lager` adapter
  mirroring `supabase.ts`. Every new `Databas` method the worker reaches goes
  into `index.ts`, `supabase.ts` and `__fakes__/lager.ts`;
  `src/server/edge/build.test.ts` fails when the glue lacks one.
- **Secrets** (Supabase secrets, separate from Lovable's): `PROJECT_URL`,
  `PROJECT_SECRET_KEY`, `AUTOMATIONS_KEY`, `ANTHROPIC_API_KEY`,
  `MAX_DAILY_SPEND_SEK`, `ANALYSIS_KILL_SWITCH`, optional
  `MAX_COST_PER_ANALYSIS_SEK` and `ANTHROPIC_EFFORT_GROUNDING|EXTRACTION|JUDGING`
  (default `medium`; transcription uses the grounding effort). No
  `ANTHROPIC_MODEL`: the model comes from the rapport row. Set them with
  `supabase secrets set --env-file <file>`, never inline.
- **Naming:** both Supabase and Lovable refuse secret names starting with
  `SUPABASE_`, and the platform's auto-injected `SUPABASE_*` values are the
  disabled legacy keys, so all three runtimes (Node CLIs, the Worker, Deno)
  read `PROJECT_*`. Rotating `ANTHROPIC_API_KEY` means updating `.env.local`,
  Lovable Secrets and Supabase secrets.

## Applying changes

- **Migrations:** no npm script. Locally `npx supabase@2.117.0 db reset --local`
  (applies all migrations; `v2-lokalt.sh` does it on first run). Production:
  `npx supabase@2.117.0 db push`, only with the owner's explicit OK. Check
  with `npx supabase@2.117.0 migration list --linked`.
- **Edge Function:** `npm run deploy:edge` builds the bundle and deploys
  `analys-steg`; owner OK only.
- **Order:** migration first, then `deploy:edge`, then the Lovable publish of
  the web app. A `PROMPT_VERSION` bump needs both the Edge Function and the
  web app deployed close together; jobs created in between fail with
  `versionskonflikt`.
- To stop new work during a risky change, set `ANALYSIS_KILL_SWITCH=on` in
  both Lovable and Supabase secrets.

## Local stack

`./scripts/v2-lokalt.sh [--nollstall]` runs the whole app against a local
Supabase stack in Docker:

- starts Supabase (CLI 2.117.0), applies all migrations on the first run or
  with `--nollstall`;
- writes the local Vault secrets `project_url` (`http://kong:8000`, the
  gateway as seen from inside Docker) and a random `automations_key`;
- builds the bundle and serves `analys-steg` with a temporary env file, so
  the real cron tick drives the real worker;
- runs `npm run dev` on `localhost:8080` with every `PROJECT_*` and spend
  variable exported with LOCAL values (daily cap 50 kr), and refuses to start
  if `PROJECT_URL` is not local. Only `ANTHROPIC_API_KEY` is read from
  `.env.local`, so analyses cost real Claude money.

`node --import tsx scripts/seedLokaltRegister.ts` seeds `/brf` with test
BRFs and refuses a non-local `PROJECT_URL`. Stop the containers with
`npx supabase@2.117.0 stop`. `config.toml` references a `seed.sql` that does
not exist; that is harmless.

`.env.local` points at production: never create analyses with a plain
`npm run dev`.

## Live verification and admin

All of these talk to the LIVE project with the secret key from `.env.local`;
run them only with the owner's OK.

- **`npm run verify-rls`**: writes probe rows (marked `verify-rls`, never
  claimable or matchable) into the server tables with the secret key, checks
  that the publishable key can neither read, write, update nor delete them and
  is denied EXECUTE on every service-role RPC. Exits 1 on any deviation and
  cleans up in `finally`. It never calls `claim_next_rapport_steg` with the
  secret key (that would claim a real job).
- **`npm run register -- …`** (`registerCli.ts`, no Anthropic calls; `rerun`
  only queues, the worker spends under the daily cap):

  ```
  list [--orgnr X] [--limit N]
  inspect <rapportId> | inspect <orgnr> <år>      # flags missing PDFs
  invalidate <rapportId> [--all-versions] [--force]
                       # failed + 'ogiltigforklarad', frees both slots; refuses a
                       # running rapport without --force (its leased write is then dropped)
  rerun --to-current [--limit N] [--dry-run]       # queue current-version re-runs
  backfill-legacy [--dry-run]                      # legacy caches → register, idempotent
  ```

- **`npm run konto -- radera|exportera <principalId>`**: GDPR erasure and
  export (see "Retention and erasure").
- **`npm run analys -- <pdf> <input.json>`**: creates a real job through
  `skapaAnalys`, polls status and prints the result (real spend; needs the
  deployed worker).

## Legacy

Objects that still exist but no longer carry new work:

- **The `analys` row queue.** Rows without `rapport_id` (created before the
  register) are still claimed by `claim_next_steg` (it skips register-linked
  rows) as a fallback in `korNastaSteg`, and released by `slapp_steg`. Their
  stages are uploaded → extracting → judging → complete, keyed on
  `(pdf_hash, model, prompt_version)`, with version guard on
  `prompt_version`.
- **`extraktion_cache` / `analys_cache`**: keyed on
  `(pdf_hash, model, prompt_version)`. Read and written only for those legacy
  rows; `register -- backfill-legacy` copies the current prompt version's rows
  into the register.
- **Columns** `analys.lan_underlag` (dead since the calculator became
  client-side; nullable, commented in the database) and the `analys` job
  columns (`grundtext`, `lease_until`, `attempts`, `error_*`, `cost_sek`, …),
  which are used only by legacy rows.
- **`slapp_rapport_steg`**: defined and granted, but the worker re-queues
  through leased writes instead; only `verifyRls.ts` calls it (as a probe).
- **`radera_analys`**: called only from `radera_min_analys`.
- **`analys_klaim_idx`**: the legacy queue's partial claim index.
