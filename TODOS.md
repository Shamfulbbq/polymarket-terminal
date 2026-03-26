# TODOS

## P1 — Blocking

### Verify Polymarket fee parameters before March 30
- **What:** Verify C and exponent values in `data/feeSchedule.json` against Polymarket's official fee schedule for all 11 categories.
- **Why:** Incorrect fee parameters = wrong PnL calculations, wrong trade filtering in weather bot, wrong rebate estimates in CMM.
- **Context:** The current estimated values (crypto C=0.25, weather C=0.16, sports C=0.03/exp=0.5) are derived from public announcements and reverse-engineering. Polymarket's March 30 expansion adds fees to weather, politics, tech, finance, and others. The sports exponent (0.5 vs 2.0 for other categories) is unverified and could be wrong. Check https://docs.polymarket.com/trading/fees and any March 2026 announcements.
- **Effort:** S (human: ~30min / CC: ~10min)
- **Depends on:** Polymarket publishing final fee schedule.
- **Deadline:** March 29, 2026.
