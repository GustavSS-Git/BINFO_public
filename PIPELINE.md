# Analysis pipeline: design rationale

Why the årsredovisning pipeline in `src/lib/analysis/` looks the way it does.
`CLAUDE.md` ("The analysis pipeline") describes what each stage does; this file
explains the choices behind them.

> When this file and the code disagree, the code wins. Fix this file.

## Facts first, judgement second

A single prompt that reads the PDF and writes the finished report is quick to
build and impossible to test. The pipeline is split instead:

| Stage                          | Input → output                                              | Has a right answer?             |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------- |
| Grounding                      | PDF (or transcription) → cited findings                     | Yes: the quote is on the page   |
| Extraction                     | Findings → `ExtractionResult` (JSON)                        | Yes: scored against answer keys |
| Judging                        | Extraction + Binfo's fixed values → grade, flags, questions | No                              |
| Assembly (on every read, code) | Extraction + judgement + the buyer's flat → report          | Yes: unit-tested                |

Keeping facts and judgement apart means that when a report is wrong, you can
tell which half failed. The judging model never sees the buyer's data, so its
output can be stored once per förening and year and shared by every buyer.

## Why grounding and extraction are two calls

Every figure must carry a page reference that comes from the API, never from the
model's own claim. The Citations feature gives exactly that, but the API cannot
combine citations with structured JSON output. So:

1. **Grounding** reads the whole report with citations on and quotes the
   passages that hold each figure.
2. **Extraction** turns those quotes into schema-shaped JSON with no PDF in
   context.

Code then checks every cited excerpt against the page text
(`sidreferenser.ts`): a quote on the wrong page is moved, a quote that can't be
found marks the figure uncertain and adds a question.

## The model computes nothing

- **Statuses** come from fixed bands (`BENCHMARKS.md`, `benchmarks.ts`), not
  from the model.
- **Derived figures** (a debt-free förening's zero debt ratios, sums, the loan
  maturity profile) are computed in code after extraction.
- **Judging** receives Binfo's own "Fasta värden" (`fastaVarden.ts`) and is told
  not to calculate. Code clamps the grade to what the statuses allow and checks
  every number in the written motivation against the extraction; one small
  rewrite call is allowed, then a deterministic fallback.
- **Everything with a date** (the fee prognosis, refinancing, the price
  adjustment) is computed per read in `assemble.ts`, so it is always relative to
  today and never frozen into stored model text.

## Answer keys

`fixtures/answer-key/` holds the seven nyckeltal worked out by hand for 13
föreningar from different management companies (HSB, Riksbyggen, SBC, Nabo and
others), because their report templates differ a lot. `answer-key-lan/` and
`answer-key-underhall/` hold draft keys for loans and building parts.

`npm run verify-extraction -- <dir>` runs the pipeline over the reports and
reports every deviation field by field. Tolerance: exact for figures printed
verbatim, ±1 % for derived ones. `VERIFY_FROM_RESULTS=<dir>` re-scores saved
results for free.

Without the keys there is no way to know whether a prompt change helped.

## Pure functions, tested first

Everything with an unambiguous answer lives in plain functions with unit tests
written before the implementation: `calc/` (amortisation, interest deduction,
rate stress, monthly cost, the fee prognosis, the savings need), `benchmarks.ts`,
`tolkaVarde.ts`, `rimlighet.ts`, and the request builders and response parsers
of every stage (`bygg*Request` / `tolka*Svar`; golden tests pin the request
bodies).

One example of why: since 1 April 2026 amortisation depends on loan-to-value
only. A loan of 4 500 000 kr on an income of 800 000 kr at 80 % LTV must give
2 %, not the 3 % that older rules (and models trained on them) would give.
`calc/amortering.test.ts` pins that case.

## Failure modes, handled explicitly

| Case                                  | Behaviour                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Scanned PDF (no text layer)           | Transcribed in parallel chunks into a citable document; figures tagged `skannad`, confidence at most medium |
| Garbled text layer                    | Handled on the normal path (measured better than transcription)                                             |
| A key figure genuinely absent         | `value: null`, listed as missing, turned into a question for the visning; never fails the analysis          |
| Räntekänslighet missing               | Only the rate stress is disabled                                                                            |
| Malformed model output                | Zod validation fails, one blind retry, then a visible failure                                               |
| Quote not found on the cited page     | Figure marked uncertain + a question                                                                        |
| Implausible or inconsistent figures   | Sanity checks (`rimlighet.ts`) mark them uncertain rather than silently picking one                         |
| Report older than 18 months           | Noted in the fee prognosis; matured loans are listed but never priced                                       |
| Grade outside what the statuses allow | Clamped, and the clamp is logged                                                                            |

A silent, empty or confident-but-wrong analysis is the worst failure. A visible
failure is acceptable.

## Cost

A text report costs about 3.2 kr (1.98–3.82 kr, n = 8; Sonnet 5.5, effort
medium); a scanned one 4–6.5 kr; a report already in the register costs
nothing. Grounding is about 62 % of the cost. Spend is capped per analysis
(`MAX_COST_PER_ANALYSIS_SEK`) and per day (`MAX_DAILY_SPEND_SEK`). At these
amounts there is no reason to trade output quality for tokens.
