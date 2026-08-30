# CryptoPulseV2 — Daily AI Audit

## Objective

Produce a daily machine-readable report suitable for independent ChatGPT analysis.

The daily report must answer:

"What happened yesterday, how did the models perform, and what should we investigate?"

---

# Daily Execution

The report should be generated automatically by a scheduled Cloudflare Worker job.

Recommended execution:

Once per day after sufficient prediction horizons have resolved.

The existing Worker cron infrastructure should be reused where practical.

---

# Daily Report Sections

## 1. Dataset Health

Report:

- total rows
- new rows
- missing rows
- stale data
- unresolved predictions
- resolved predictions
- data source failures

---

# 2. Overall Performance

Calculate:

- accuracy
- Brier score
- log loss
- calibration error
- directional accuracy
- average predicted probability
- realized up-rate

---

# 3. Confidence Analysis

Calculate performance buckets:

0.50-0.55
0.55-0.60
0.60-0.65
0.65-0.70
0.70-0.75
0.75-0.80
0.80+

Identify:

- most confident correct predictions
- most confident incorrect predictions
- systematic overconfidence
- systematic underconfidence

---

# 4. Model Comparison

Compare:

- Production
- Challenger
- relevant research variants

Metrics:

- accuracy
- Brier
- log loss
- calibration error
- sample size

---

# 5. Regime Analysis

Analyze:

- bullish regime
- bearish regime
- neutral regime
- high volatility
- low volatility
- unusual volatility

Compare model performance across regimes.

---

# 6. Feature Analysis

Evaluate whether feature values correlate with:

- correct predictions
- incorrect predictions
- realized direction
- confidence errors

Do not automatically change feature weights.

Feature findings are hypotheses for future experiments.

---

# 7. Error Analysis

Identify:

- largest directional errors
- largest return errors
- most confident mistakes
- repeated failure conditions

For each major error provide:

- prediction
- actual outcome
- model
- features
- regime
- confidence
- possible explanation

---

# 8. Market Catalyst Analysis

For significant market moves, identify potential catalysts.

Catalyst categories:

- macro
- Fed
- rates
- inflation
- employment
- USD
- ETF flows
- regulation
- exchange events
- stablecoins
- liquidations
- leverage
- technical events
- on-chain events
- geopolitical
- unexpected events

Each catalyst must include:

- event timestamp
- source
- source URL
- affected asset
- direction
- confidence
- available_before_prediction

---

# 9. Hindsight Protection

Never classify a post-prediction event as something the model "should have known."

The report must distinguish:

KNOWN_BEFORE
EMERGING_BEFORE
UNKNOWN_BEFORE
DISCOVERED_AFTER

---

# 10. Model Drift

Compare recent performance against historical baseline.

At minimum compare:

- last 24h
- last 7d
- last 30d
- full history

Flag significant deviations.

---

# 11. Candidate Experiments

The system may identify potential experiments.

Every candidate must include:

- observation
- supporting sample size
- hypothesis
- expected mechanism
- suggested experiment
- risk of overfitting

Candidates must NOT automatically alter Production.

---

# 12. Daily Report API

Implement:

GET /api/learning/daily

Optional:

GET /api/learning/daily?date=YYYY-MM-DD

Return JSON.

The endpoint must be read-only.

---

# 13. ChatGPT Analysis Endpoint

Implement:

GET /api/learning/chatgpt

Return a compact version optimized for AI analysis.

It should include:

- key metrics
- important errors
- market catalysts
- regime changes
- model comparison
- candidate experiments
- data quality warnings

Do not expose secrets.

Do not expose unrestricted database access.

---

# Daily Audit Status

The report must have:

GREEN
YELLOW
RED

GREEN:
No major anomaly.

YELLOW:
Something requires investigation.

RED:
Major data/model integrity problem or severe performance degradation.
