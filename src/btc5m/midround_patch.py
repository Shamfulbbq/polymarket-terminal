with open('/home/ubuntu/polymarket-terminal/src/btc5m/bot.mjs', 'r') as f:
    src = f.read()

# 1. Add initialPred + lastMidInferTs to _active state
old_active = """const _active = {
    slug: null, market: null,
    upBids: [], dnBids: [],
    upFilled: [], dnFilled: [],   // simulated fills accumulated this round
    upOrderIds: [], dnOrderIds: [], // live order IDs for cancellation
    hedged: false, timer: null,
};"""

new_active = """const _active = {
    slug: null, market: null,
    upBids: [], dnBids: [],
    upFilled: [], dnFilled: [],   // simulated fills accumulated this round
    upOrderIds: [], dnOrderIds: [], // live order IDs for cancellation
    hedged: false, timer: null,
    initialPred: null,            // prediction at round open
    lastMidInferTs: 0,            // timestamp of last mid-round inference
};"""

assert old_active in src, "FAIL: _active block not found"
src = src.replace(old_active, new_active)

# 2. Add fields to _clearActive
old_clear = "        signalMode: null, lastChaseSimTs: 0 });"
new_clear = "        signalMode: null, lastChaseSimTs: 0, initialPred: null, lastMidInferTs: 0 });"
assert old_clear in src, "FAIL: _clearActive line not found"
src = src.replace(old_clear, new_clear)

# 3. Insert mid-round block just before hedge trigger
MID_ROUND_BLOCK = r"""
    // ── Mid-round re-evaluation ──────────────────────────────────────────────
    // Re-runs inference every 60s. If updated confidence >=55% favours the
    // lagging fill side AND the ask is still cheap (<0.60) AND time_rem >90s,
    // places one extra rung on that side. Logs early-cut signal when model
    // strongly opposes lagging side with <90s remaining.
    {
        const nowMs = Date.now();
        if (nowMs - _active.lastMidInferTs >= 60_000) {
            _active.lastMidInferTs = nowMs;
            const seq = buildFeatureSeq();
            const midPred = await predict(seq);
            if (midPred && _active.initialPred) {
                const slugStartSec = parseInt(_active.slug.split('-').pop(), 10);
                const timeRemMid = Math.max(0, (slugStartSec + 300) - Math.floor(Date.now() / 1000));
                const upSh2 = _active.upFilled.reduce((a, r) => a + r.shares, 0);
                const dnSh2 = _active.dnFilled.reduce((a, r) => a + r.shares, 0);
                const imbalance = upSh2 - dnSh2;
                const lagSide = imbalance > 0 ? 'DN' : imbalance < 0 ? 'UP' : null;

                logger.info(`btc5m: ${_active.slug} MID_INFER pred_up=${midPred.pred_up.toFixed(3)} pred_dn=${midPred.pred_dn.toFixed(3)} initial_up=${_active.initialPred.pred_up.toFixed(3)} lag=${lagSide ?? 'BALANCED'} imbalance=${imbalance}sh time_rem=${timeRemMid}s`);

                if (lagSide && timeRemMid > 90) {
                    const lagPred  = lagSide === 'UP' ? midPred.pred_up : midPred.pred_dn;
                    const lagAskNow = lagSide === 'UP' ? upAsk : dnAsk;

                    if (lagPred >= 0.55 && lagAskNow !== null && lagAskNow < 0.60) {
                        // Model favours lagging side and it's still cheap — add one rung
                        const rungPx = +(lagAskNow - 0.01).toFixed(3);
                        if (rungPx >= GRID_MIN) {
                            const extraRung = { price: rungPx, shares: UNIT_SHARES, side: lagSide };
                            logger.info(`btc5m: ${_active.slug} MID_ADD lag=${lagSide} conf=${lagPred.toFixed(3)} ask=${lagAskNow} → extra rung @${rungPx}`);
                            const tokenId = lagSide === 'UP' ? _active.market.upTokenId : _active.market.dnTokenId;
                            await placeRung(_active.market, tokenId, extraRung);
                            if (lagSide === 'UP') _active.upBids.push(extraRung);
                            else _active.dnBids.push(extraRung);
                        }
                    } else if ((1 - lagPred) >= 0.65) {
                        // Model strongly against lagging side — flag early cut opportunity
                        const losingSh = lagSide === 'UP' ? dnSh2 : upSh2;
                        logger.warn(`btc5m: ${_active.slug} MID_CUT_SIGNAL lag=${lagSide} conf_vs=${(1-lagPred).toFixed(3)} time_rem=${timeRemMid}s losing_side=${losingSh}sh`);
                    }
                }
            }
        }
    }

"""

anchor = "    // Hedge trigger: spread locked when combined cost < HEDGE_THRESHOLD."
assert anchor in src, "FAIL: hedge trigger anchor not found"
src = src.replace(anchor, MID_ROUND_BLOCK + anchor)

with open('/home/ubuntu/polymarket-terminal/src/btc5m/bot.mjs', 'w') as f:
    f.write(src)
print('done')
