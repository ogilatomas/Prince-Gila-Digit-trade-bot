# Floating digit monitors

The dashboard has two separate floating panels:

1. **Strategy Monitor / Frequency Guard** — summarizes digit frequency and warns when two or more digits fall below its heuristic threshold after enough ticks. This is an anomaly-style alert, not proof of manipulation.
2. **Major Scanner** — independently evaluates UNDER3, UNDER4, OVER6 and OVER7 using a rolling 500-tick buffer and a displayed 20-tick entry window.

The original digit strategy engine uses a 1,000-tick window and emits signal candidates. The major scanner and original digit signal engine do not execute digit-contract purchases in this release. The checkbox labels do not enable live order execution. Quote precision and contract availability differ by market; validate them before using any signal.
