# Fee prognosis: from the årsredovisning to the price

The årsredovisning reaches the price through **one channel**: the expected rise in this flat's
månadsavgift within a horizon of 24 months. The valuation model already prices today's fee, so the
prognosis adds only what the report shows is coming. The grade never moves the price, and nothing
else in the BRF analysis is applied to the valuation (the flat's share of the förening's debt is a
comment line, never subtracted).

| What                                                 | Where                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| Every assumption (one file; change values only here) | `src/lib/analysis/calc/prognosantaganden.ts`               |
| Components, share, fee pressure                      | `src/lib/analysis/calc/avgiftsprognos.ts`                  |
| Savings target and how a gap is paid                 | `src/lib/analysis/calc/sparbehov.ts`                       |
| Lokal leases at risk / questions to the styrelse     | `src/lib/analysis/calc/lokalrisk.ts`, `lokalfragor.ts`     |
| Price adjustment                                     | `src/lib/analysis/prisjustering.ts`                        |
| Refinancing red flag and summary sentence            | `src/lib/analysis/refinansieringsflagga.ts`                |
| Fee table (today / expected / +1 / +2 pp)            | `src/lib/analysis/calc/rantestress.ts` `byggPrognosTabell` |
| Reference rate                                       | `src/server/referensranta.ts`, `referensrantaHamtning.ts`  |

Sources for the maintenance figures: `docs/underhall-referens.md`. Values marked
`TODO: unverified placeholder` in `prognosantaganden.ts` are product assumptions chosen by the
owner, not market facts.

The prognosis is buyer-level: it is computed on every read in `assemble.ts`, with today's date and
today's reference rate, from the stored extraction and the buyer's input. Nothing here is written by
the model.

## Inputs

- **From the report** (`Forening`, cited): the key figures (sparande, skuldsättning, årsavgift per
  m², räntekänslighet), `sparandeHistorik`, `totalyta`, `bostadsrattsyta`, `balansdag`, the loan
  book (`lanebok.lan` with amount, rate, villkorsändringsdag and rörlig/fast; `snittranta`,
  `rantekostnader`, `totalSkuld`), the maintenance plan, `genomfordaAtgarder`, `lokaler`,
  `energiprojekt`, `avgiftsandringar`; plus `kontrollsummor.arsavgifter`.
- **From the buyer:** månadsavgift, boarea, byggår, hiss.
- **From outside:** the reference rate (below) and today's date.

## The flat's share

All förening amounts are kr/year. A component's kr/month for the flat is
`round(förening kr/year × andel ÷ 12)`; the total is the sum of the rounded calculated components.
`andel` (`raknaAndel`), first that gives a value in (0, 1]:

1. **Fee share:** månadsavgift × 12 ÷ (årsavgifter × F).
2. **Area share:** boarea ÷ bostadsrättsyta.
3. **Derived fee share:** månadsavgift × 12 ÷ (total debt ÷ räntekänslighet × F).

F = Π(1 + p) over the decided fee raises the internal check finds already in effect (see "Decided
fee raises"): the report's årsavgifter predate them, while the buyer's fee includes them. Example
(test): fee 4 400 kr, årsavgifter 4 800 000 kr, a 10 % raise in effect → 4 400 × 12 ÷ (4 800 000 ×
1.10) = 0.01, not 0.011. Without a share there is no kr/month and no price adjustment.

Every calculated component's explanation ends with the share and its basis ("Din andel är 2,37 %
(din avgift × 12 ÷ föreningens årsavgifter ≈ 1,78 mkr), alltså ca 402 kr/mån"), so a reader can
reproduce the number.

## Components

Each component is `beraknad` (an amount), `ej_aktuell` (0 kr, nothing to price) or
`saknar_underlag` (the report lacks the data). A missing component adds nothing to the point
estimate; it only widens the low end of the price range.

### 1. Savings against the maintenance need (`spargap`)

**Target** in kr/m² totalyta per year (`beraknaSparbehov`), first available:

1. the report's `investeringsbehovPerM2`;
2. the plan's `rekommenderadAvsattning` ÷ totalyta;
3. planned costs ÷ years ÷ totalyta: `planTotal` over its years, else the listed plan items over
   their span (at least 10, at most 30 years; 30 when an item has no year). Items the `underhall`
   component already counts are left out;
4. the **schablon** 300 kr/m² (HSB; Riksbyggen 305), moved within 250–350 by the age of the
   building parts.

A plan-based target below 50 % or above 200 % of the schablon (150 / 600 kr/m²) is treated as a
partial plan or a misread and replaced by the schablon; the explanation says so.

**Building parts** (schablon only): stambyte, tak, fasad, fönster, ventilation, el, and hiss when the
buyer says the house has one. A part's last year is its latest replacement in
`genomfordaAtgarder`, else the byggår (only for extractions that looked for past renovations).
Status: `nyligen` when replaced less than half the low lifetime ago (only a cited action can make a
part `nyligen`), `eftersatt` when older than the high lifetime, `ok` in between, `okant` without a
year. A life-extending action (`omfattning: "forlangning"`, owner 2026-10-30) never resets the age
but keeps the part from counting as `eftersatt` for a fixed number of years. Score = (#eftersatt −
#nyligen) ÷ #assessed; target = 300 + 50 × score, clamped to 250–350.

| Part        | Lifetime (years) | Life extension (years) |
| ----------- | ---------------- | ---------------------- |
| Stambyte    | 40–60            | 30 (relining)          |
| Tak         | 20–60            | 10                     |
| Fasad       | 20–100           | 10                     |
| Fönster     | 40–60            | 10                     |
| Ventilation | 20–100           | (every action counts)  |
| El          | 45–50            | 10                     |
| Hiss        | 20–40            | (every action counts)  |

**Sparande** = the average of up to four years: the current key figure plus up to three years of
`sparandeHistorik` (null or osäker years skipped), rounded to whole kr/m². History is never used
without the current year. Missing totalyta is derived as total debt ÷ skuldsättning per m² totalyta
(kept only when ≥ 100 m²).

**Gap = target − sparande.**

- **Gap > 0** (owner 2026-10-29): the gap is split into a part the fee must pay and a part the
  förening can borrow.
  - underskott per m² = max(0, −sparande): a sparande below zero is always paid by the fee;
    D = underskott × totalyta.
  - lånebart per m² = target − max(sparande, 0); G = lånebart × totalyta.
  - Debt per m²: `skuldsattning_per_m2_totalyta` (on totalyta), else
    `skuldsattning_per_m2_brf_yta` (on bostadsrättsyta, which must be known). Osäker or missing
    counts as unknown.
  - Headroom = max(0, `SKULDTAK_KR_PER_M2` − debt per m²) × area, with the ceiling at 5 000 kr/m²
    (the acceptabel/svag limit in `BENCHMARKS.md`); 0 when the debt is unknown.
  - Borrowed = min(2G, headroom): two years of gap, the horizon.
  - Förening kr/year = D + (G − borrowed ÷ 2) + borrowed × rate, where rate = reference rate +
    BRF margin (the refinancing rate). Within the horizon only the interest on borrowed money
    reaches the fee.
- **Gap ≤ 0** (a surplus): förening kr/year = gap × totalyta × weight, where the weight is 1 for a
  plan-based target and 0.5 for the schablon (`SPARMAL_SCHABLON_DAMPNING`). A surplus lowers the
  expected fee.

Cash flow is deliberately not a price input. The sparande _status_ (green/yellow/red in the
nyckeltal list, `benchmarks.ts`) is a separate number from this target. A planned, financed
withdrawal from savings is only mentioned in the text.

**Worked example (Brf Ingemar 8, FY2025; `sparbehov.test.ts`, `avgiftsprognos.test.ts`).**
Sparande −3, −138, 125, 119 → average 26 kr/m²; schablon target 300 → gap 274. Totalyta 2 485 m²,
so G = 680 890 kr; D = 0. Debt 3 411 kr/m² → headroom (5 000 − 3 411) × 2 485 = 3 948 665 ≥ 2G,
so 1 361 780 kr is borrowed. At 2.068 % + 0.58 = 2.648 %, the förening pays ≈ 36 060 kr/year. A flat
with fee 3 100 kr and årsavgifter 1 359 772 kr gets ≈ 82 kr/month.

### 2. Refinancing (`refinansiering`)

New rate = reference rate + `BRF_MARGINAL_PROCENT` (0.58 pp). A loan's current rate is its own,
else `snittranta`, else räntekostnader ÷ total debt. A loan counts as rörlig when the report says so
or when it resets at most 3 months after the balance date.

- **Phase 1 (months 0–24):** every rörlig loan and every dated loan resetting within the horizon,
  at full weight: amount × (new − current) ÷ 100. This can be negative: refinancing at a lower rate
  lowers the fee and raises the price.
- **Phase 2 (months 25–60):** dated loans whose current rate is _below_ the new rate, weighted 0.75
  (to month 36), 0.5 (48) and 0.25 (60). A cut that far ahead is never priced; undated debt has no
  later phase.
- **Unknown timing:** undated loan rows, plus total debt the rows do not cover (beyond a 2 %
  tolerance), are assumed to reprice at 50 % (`REFINANSIERINGSANDEL_UTAN_FORFALL`). When the report
  gives no maturities at all, 50 % of the whole debt is assumed. In both cases the price range shows
  the outcome with 0 % and 100 % of that debt repricing.
- **Matured loans:** a dated fixed-rate loan whose reset date is on or before today has already
  been reset to unknown terms. It is listed with `fas: "forfallit"` and never priced, whatever the
  report's age.
- **Reports older than 18 months** (balance date + `MAX_RAPPORTALDER_MANADER` before today): rörlig
  and undated debt has most likely been refinanced too and is left out. Loans whose reset date is
  still ahead keep the report's rate until then and are priced normally. With none left, the
  component is `saknar_underlag`. The explanation names the report's age.
- Debt-free förening → `beraknad`, 0 kr. No debt figure at all → `saknar_underlag`.
- Old extractions (before per-loan dates) know only the maturity year: the loan is placed on 1 July
  and counts as matured only once that year is over.

Example (Näcken-like stale report, test): FY2024 read on 2026-10-25. 16 576 000 kr reset in 2025 and
are not counted. 9 472 000 kr at 3.25 % (2026-12-28) and 5 920 000 kr at 4.50 % (2027-09-28) at
2.648 % give −166 660 kr/year.

**Flag and sentence** (`refinansieringsflagga.ts`): built per read from the same component, never
from model text (a stored model flag about refinancing is recognised by its title and dropped). No
flag when under 10 % of the debt resets or has matured and the effect is under 10 kr/month.
Severity `hog` when the component is red; `medel` when it is yellow, when ≥ 50 % of the debt has
matured, or when ≥ 50 % resets with a rise of at least 10 kr/month; else `lag`.

### 3. Unfunded maintenance (`underhall`)

Plan items with an amount that are unfinanced (or financing unknown) and fall in the calendar years
from today to the horizon end; items without a year count too. Remainder = their sum − the
maintenance fund − the yearly allocation × 10; a positive remainder is spread over 10 years
(`UNDERHALL_FORDELNING_AR`). No plan item with an amount → `saknar_underlag` (a missing plan says
nothing about the next years); amounts all outside the window → 0 kr.

### 4. Lokal rent at risk (`lokaler`)

Owner decision 2026-10-25, a compromise between "a lease end is not a loss" and caution:

1. **Loss signal** (`lokaler.forlustsignaler`, cited: terminated lease, tenant leaving, vacant
   premises, insolvent tenant, rent dispute or reduction): **100 %** of the rent
   (`LOKALHYRA_ANDEL_VID_FORLUSTSIGNAL`).
2. **Lease ending** between the balance date and the horizon end (including one that already ended
   after the balance date, since the report cannot say what happened) with no cited renewal or new
   tenant (`fornyelse`): **50 %** of the rent (`LOKALHYRA_RISKANDEL`, a 50 % probability).
3. A renewed lease, a lease ending outside the window, or neither → nothing at risk (`ej_aktuell`).

Rent per item: its own `arshyra`, else hyresintakter ÷ max(number of leases, antalLokaler, 1). Any
at-risk item without a rent figure → `saknar_underlag`. No double counting: signals are summed first
and capped at the year's hyresintakter (scaled proportionally); ending leases are then capped at the
rent the signals did not cover. A lease whose `arshyra` equals a signal's is taken to be the same
rent and is counted once, by the signal. Each item is rounded on its own, so the amounts in the
explanation add up to the component. No förening with lokaler, or a cited zero lokal rent →
`ej_aktuell`.

Example (Volontären-like, test): one lease, no `arshyra`, hyresintakter 244 380 kr, ended
2024-12-31, balance date 2023-12-31, read 2026-10-25 → 244 380 × 50 % = 122 190 kr/year; at a 1 %
share, 102 kr/month.

**Questions to the styrelse** (`lokalfragor.ts`, per read): one per loss signal and one per ending
lease not renewed and not covered by a signal, **at most three**, largest rents first. All are
skipped when an existing question already mentions lokal, hyresavtal or hyresgäst.

### 5. Energy projects (`energi`)

Unfinanced energy projects with an amount, ÷ 10 years. A project with unknown financing, or
unfinanced without an amount → `saknar_underlag`. No projects → `ej_aktuell`. Today's energy cost is
already in today's fee and is never added.

### 6. Decided fee raises (`beslutad_hojning`)

The report lists decided or planned changes of the bostäder's årsavgift (`avgiftsandringar`: signed
percent, optional start date, cited; not lokal rents or IMD). A change is **relevant** when it is a
raise (percent > 0, not osäker) and starts after the balance date or has no date. A decrease is
never priced.

The report is older than the buyer's fee, so a raise may already be in it. The internal check
`avgiftsandringKontroll` (never shown on the web or in the PDF) decides per relevant raise:

- `datum`: start ≤ today → `passerat`; later → `framtida`; none → `okant`.
- Estimated fee before = key figure årsavgift per m² bostadsrättsyta × boarea ÷ 12; after = × (1 +
  p). Raises are sorted by date (undated last) and compound. `avgift` = whichever estimate the
  buyer's fee is closer to (a tie or a missing key figure → `okant`). The key figure is an average
  per m², so a small raise cannot be told apart from the spread between flats.
- `slutsats`: a known date decides (`i_kraft` / `ej_i_kraft`), with `konflikt` when the fee points
  the other way. Without a date the fee decides; both unknown → `okant`.

Example (Volontären-like, test): fee 2 104 kr, 50 m², key figure 404 kr/m², +25 % from 2024-05-01
→ before 1 683, after 2 104 → `matchar_efter`, `i_kraft`.

**Component:** no relevant raise, or all in effect → `ej_aktuell` (the text names a raise already in
the fee). Any `okant` → `saknar_underlag`. Otherwise kr/month = Σ månadsavgift × p over the raises
not yet in effect.

**Offset against the savings gap:** a raise is the förening's own answer to its gap, so the yearly
revenue of every relevant raise is subtracted from a positive, calculated `spargap` amount (floor
0; no other component is offset). Revenue = the förening's fee income (månadsavgift × 12 ÷ andel)
× p; for a raise already in effect today's fee contains it, so the revenue is that income × p ÷ (1 +
p). The target and gap in kr/m² are not changed. Without a share nothing is offset.

The fee-deviation question compares the buyer's fee with the report's level raised by the raises in
effect, and names both levels.

## Total, fee pressure and the 30 % guard

- **Fee pressure** (`tryckFor`), per component and for the total: |kr/month| ÷ today's fee below
  2 % green, up to 10 % yellow, above red. A decrease is green.
- A total above 30 % of today's fee (`MAX_RIMLIG_HOJNING_ANDEL`) is still applied, but marked
  osäker and turned into a question (it guards against, say, a 30-year maintenance total misread as
  one year).
- **Fee table** (`byggPrognosTabell`): today's fee; the expected fee (today + total, unchanged
  rate); and +1 / +2 pp layered on the expected fee, applied to the whole debt through
  räntekänslighet. Without räntekänslighet the +1 / +2 rows are omitted.

## Price adjustment

`byggPrisjustering`, on Binfo's baseline valuation:

- kr of price per kr/month of fee = −β × baseline ÷ boarea (the flat's own kr/m²);
- adjustment = round(−total × that); adjusted value = baseline + adjustment.

β = `AVGIFT_BETA_LOG_PER_KR_M2` = −0.0024470683 per kr/m² of monthly fee on log(kr/m²), the OLS
companion of valuation v3.1 (`ml/artifacts/valuation-v3.1/metadata.json`,
`effects_fee_per_sqm.fee_per_sqm_per_kr_beta_log`; 95 % CI −0.00280 to −0.00210, p = 1.9e-42,
n = 4 991). A test keeps the constant in sync with the artifact. At 122 000 kr/m² that is about
−300 kr of price per kr/month of fee; at 51 000 kr/m², about −125 kr.

Why OLS and not the trees: the LightGBM model uses `fee_per_sqm` without a monotone constraint, and
finite differences on seven test flats (+100 to +1 000 kr/month) gave −1 278 to +170 kr per kr/month,
with sign flips: unusable as a slope. The coefficient is an association, not a causal effect (the fee
level partly proxies debt and condition), and the texts say so.

**Range:**

- The baseline's range is shifted by the adjustment.
- Each `saknar_underlag` component, and an unknown share, widens the **low end only** by 3 %
  (`BREDDNING_PER_SAKNAT_UNDERLAG`) of the baseline. Missing data never moves the point value.
- Assumed refinancing (unknown timing) extends the range to the 0 % and 100 % outcomes.
- Unknown share → no adjustment at all, plus one 3 % widening.

## Reference rate

New BRF rates are priced from the Riksbank's **3-month T-bill (SSVX), SWEA series `SETB3MBENCH`**,
fetched from the open SWEA API (no key). Order: today's cached value (table `referensranta`, one
fetch per Stockholm day) → a fresh fetch → the last cached value, however old → the configured
fallback (2.068 %, 2026-10-23, labelled `reserv`). A read never fails for lack of a rate.

STIBOR would be the natural rate, but the Riksbank's STIBOR series end in 2020, and SFBF's data is
for personal use only (commercial use needs a paid licence; its site also blocks server requests).
Switching to a licensed STIBOR source means a new source in `referensranta.ts` and re-measuring the
margin against it.

## The BRF margin (0.58 pp)

Measured on the test reports: variable loans only (labelled "rörlig", or resetting within 3 months
of the balance date: the reports almost never state the type, and a 3-month loan resets quarterly).
Margin = the loan's rate − SSVX 3M on the balance date.

| BRF (balance date)              | Loan (rate, reset date) | SSVX  | Margin (pp) |
| ------------------------------- | ----------------------- | ----- | ----------- |
| Volontären 12 (2023-12-31)      | 4.85 % 2024-01-02       | 3.984 | 0.87        |
|                                 | 5.70 % 2024-03-07       | 3.984 | 1.72        |
|                                 | 5.05 % 2024-03-01       | 3.984 | 1.07        |
| Beckasinen 14 (2024-12-31)      | 3.54 % 2025-01-20       | 2.422 | 1.12        |
| Helsingborgshus 17 (2025-08-31) | 2.61 % 2025-09-28       | 2.026 | 0.58        |
| Torsborgen 3 (2025-12-31)       | 2.43 % 2026-01-28       | 1.948 | 0.48        |
|                                 | 2.32 % 2026-03-28       | 1.948 | 0.37        |
| Pontonjären 3 (2025-12-31)      | 2.53 % 2026-03-28       | 1.948 | 0.58        |

- Per loan: median 0.73. Per BRF (median of each BRF's loans): 1.07, 1.12, 0.58, 0.425, 0.58 →
  **median 0.58 pp, the default**. 2025 loans alone: 0.37–0.58.
- Against the policy rate the per-BRF median would be 0.78.
- No qualifying variable loan in the other test reports (Granen 10-11, Hökensgata 1, Albohem,
  Näcken 2, Zederslundshus); Göken 29 is debt-free; one loan table was garbled and two image scans
  could not be read.

## Known limits

- The savings gap and unfunded maintenance can overlap when the year's negative sparande is itself
  maintenance spending.
- Most reports give no maintenance plan amounts, so `underhall` usually widens the range instead of
  adding an amount.
- The fee share assumes the flat pays its fee share of every förening cost; the texts state the
  basis.
