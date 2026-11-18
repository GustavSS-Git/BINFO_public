# Benchmark thresholds

The status bands for the seven statutory nyckeltal (BFNAR 2023:1). They are
product decisions, not statistical results. `src/lib/analysis/benchmarks.ts`
mirrors this file exactly; change both together.

- **Grading is deterministic.** The model never assigns a status. Bands are
  evaluated best to worst and the first match wins, so a value exactly on a
  boundary lands in the better band (e.g. 500 kr/m² is "acceptabel", 1 000 is
  still "acceptabel").
- **Reference points** are population figures shown next to the förening's own
  number. They are context, not thresholds. Where none is given, none is shown.
- **Comments** are caveats passed to the judging prompt and the UI. They never
  change the grade. Changing one changes prompt text, so it needs a
  `PROMPT_VERSION` bump.
- A "lower is better" figure is never graded "god" from a negative value: a
  negative debt, fee or energy cost means the data is wrong, so it is graded
  `okant` instead.
- All seven figures are extracted. The second one is shown without a grade.

## 1. Årsavgift per m² bostadsrättsyta (kr/m²/år)

| Status     | Range         |
| ---------- | ------------- |
| God        | < 500         |
| Acceptabel | 500 – 1 000   |
| Svag       | 1 000 – 1 500 |
| Kritisk    | > 1 500       |

Reference point: Stockholm average ~833 kr/m²/år (HSB Bostadsrättsbarometer
2025, 762 föreningar, räkenskapsår 2024).

## 2. Årsavgifternas andel av rörelseintäkter (%)

Not graded ("Ingen bedömning"). The direction is ambiguous: a low share can mean
healthy commercial income or a fragile reliance on non-fee income. Shown as a
plain number in the report, the PDF and the register.

## 3. Skuldsättning per m² totalyta (kr/m²)

| Status     | Range          |
| ---------- | -------------- |
| God        | < 2 000        |
| Acceptabel | 2 000 – 5 000  |
| Svag       | 5 000 – 10 000 |
| Kritisk    | > 10 000       |

No reference point.

## 4. Skuldsättning per m² bostadsrättsyta (kr/m²)

Same bands as figure 3.

Reference point: national average ~7 117 kr/m² (2023, derived from Nabo/SCB).

The fee prognosis uses the boundary between "acceptabel" and "svag" (5 000
kr/m²) as the debt ceiling up to which a savings gap can be borrowed
(`SKULDTAK_KR_PER_M2`).

## 5. Sparande per m² totalyta (kr/m²/år)

| Status     | Range                        |
| ---------- | ---------------------------- |
| God        | > 300                        |
| Acceptabel | 0 – 300 (both ends included) |
| Svag       | < 0                          |

There is no "kritisk" band. No reference point.

Comment: negative sparande is common and not automatically critical if it is a
planned, disclosed drawdown for renovation. Check it against the significant
events and the maintenance plan before flagging it red.

## 6. Räntekänslighet (%)

| Status     | Range  |
| ---------- | ------ |
| God        | < 2    |
| Acceptabel | 2 – 5  |
| Svag       | 5 – 15 |
| Kritisk    | > 15   |

Reference point: national average ~10.3 % (2023, Nabo): fees would need to rise
about 10 % to absorb a one-point rate increase. This is the most important
figure in the product; the rate stress uses it directly.

## 7. Energikostnad per m² totalyta (kr/m²/år)

| Status     | Range     |
| ---------- | --------- |
| God        | < 100     |
| Acceptabel | 100 – 250 |
| Svag       | 250 – 500 |
| Kritisk    | > 500     |

Reference point: national average ~203 kr/m²/år (2023, SCB/Nabo).

Comment: older buildings, especially those built before the 1960s, normally
have a materially higher energy cost per m². Take the building year into
account before describing a high figure as a problem.

## The overall grade

The grade A–E is written by the judging model but clamped to what the status
counts allow (`tillatnaBetyg` in `src/lib/analysis/slutfor.ts`):

| Statuses                     | Allowed grades |
| ---------------------------- | -------------- |
| No svag, no kritisk          | A–C            |
| One svag, no kritisk         | B–C            |
| Two or more svag, no kritisk | C              |
| Any kritisk                  | C–E            |
