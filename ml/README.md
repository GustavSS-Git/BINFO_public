# Valuation model (offline)

Python code that trains Binfo's apartment valuation model and builds the
postcode → area mapping. Nothing here runs in production: the trained model is
exported as JSON and evaluated by a small tree evaluator in TypeScript
(`src/lib/vardering/`).

## Model versions

| Version | Directory                   | Status                                                                                |
| ------- | --------------------------- | ------------------------------------------------------------------------------------- |
| v3.1    | `artifacts/valuation-v3.1/` | **Shipped.** v3 with a postcode effect shrunk toward the 4-digit neighbourhood        |
| v3      | `artifacts/valuation-v3/`   | Reference; v3.1 is built from it. Area model + general model for the rest of the län  |
| v2      | `artifacts/valuation-v2/`   | Superseded. Feature set restricted to what the product can ask for; first JSON export |
| v1      | `artifacts/valuation-v1/`   | Superseded. Full feature set, kept as a comparison point                              |

Each directory has a `MODEL_CARD.md` with data, method, evaluation and caveats.
Start with `valuation-v3.1/MODEL_CARD.md` (a delta) and `valuation-v3/MODEL_CARD.md`.

In short: LightGBM on log(price per m²), trained on about 5 000 sales in
Stockholms kommun (Svensk Mäklarstatistik, January–August 2026), cross-validated
on January–June and tested on July–August. Stockholms kommun has an area model
(CV MAPE 9.6 %); elsewhere a general model (no postcode) gives the relative
effects, scaled to the kommun's 12-month average price per m². A separate OLS on the same data gives the factor effects
and the fee coefficient used by the fee prognosis.

## Files

- `cleaning.py`: loads and cleans the transaction file.
- `train_valuation.py`: v1/v2 training, the OLS effects (`fit_ols`,
  `build_driver_effects`) and `DATA_PERIOD`.
- `train_valuation_v3.py` + `valuation_v3_lib.py`: v3 (area and general models,
  seeded 40-config search, smearing, conformal interval).
- `train_valuation_v31.py` + `valuation_v31_lib.py`: v3.1 (postcode encoding
  only).
- `build_regional_prisniva.py`: kommun price levels → `data/derived/regional_prisniva.json`.
- `stats_bid_diff.py`: asking vs final price by area → `data/derived/utgangspris_vs_slutpris.json`.
- `mapping/`: postcode → area / kommun / stadsdel / register area. Sources,
  licences and method: `mapping/README.md`.
- `REGIONAL_DESIGN.md`: how prices outside Stockholms kommun are handled.
- `tests/`: pytest suite.

## Running

```sh
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/pytest                                   # from ml/
npm run build:vardering-data                       # from the repo root: artifacts → src/lib/vardering/data
```

Retraining needs the Svensk Mäklarstatistik transaction files in `data/raw/`,
which are not part of this public repository. The tests that need them are
skipped; everything else (the exported artifacts, the derived tables and the
mapping) is included.
