/**
 * signals.js
 * Signal functions for the directional sniper backtester.
 *
 * Each signal receives an array of 1-minute candles (the "signal window" —
 * the first N minutes of a 15-minute market) and returns:
 *   { direction: 'UP' | 'DOWN' | null, confidence: 0-1 }
 *
 * null direction = no trade (signal is uncertain).
 */

/**
 * Momentum: predict continuation of the trend observed in the signal window.
 * If price moved up, predict UP. If down, predict DOWN.
 *
 * @param {Array} candles — signal window candles
 * @param {Object} opts — { threshold: minimum % move to trigger (default 0) }
 */
export function momentum(candles, opts = {}) {
    const threshold = opts.threshold ?? 0;
    if (candles.length === 0) return { direction: null, confidence: 0 };

    const openPrice = candles[0].open;
    const closePrice = candles[candles.length - 1].close;
    const pctChange = ((closePrice - openPrice) / openPrice) * 100;

    if (Math.abs(pctChange) < threshold) return { direction: null, confidence: 0 };

    const direction = pctChange >= 0 ? 'UP' : 'DOWN';
    const confidence = Math.min(Math.abs(pctChange) / 0.5, 1); // cap at 0.5% move = 100% confidence
    return { direction, confidence };
}

/**
 * Taker Buy Ratio: if aggressive buyers dominate, predict UP; sellers → DOWN.
 * Uses Binance's takerBuyBaseVol vs total volume from the kline data.
 *
 * @param {Array} candles — signal window candles
 * @param {Object} opts — { buyThreshold: 0.55, sellThreshold: 0.45 }
 */
export function takerBuyRatio(candles, opts = {}) {
    const buyThreshold = opts.buyThreshold ?? 0.55;
    const sellThreshold = opts.sellThreshold ?? 0.45;

    if (candles.length === 0) return { direction: null, confidence: 0 };

    let totalVol = 0;
    let totalTakerBuy = 0;
    for (const c of candles) {
        totalVol += c.volume;
        totalTakerBuy += c.takerBuyBaseVol;
    }

    if (totalVol === 0) return { direction: null, confidence: 0 };

    const ratio = totalTakerBuy / totalVol;

    if (ratio >= buyThreshold) {
        return { direction: 'UP', confidence: Math.min((ratio - 0.5) / 0.2, 1) };
    }
    if (ratio <= sellThreshold) {
        return { direction: 'DOWN', confidence: Math.min((0.5 - ratio) / 0.2, 1) };
    }

    return { direction: null, confidence: 0 };
}

/**
 * Mean Reversion: if price moved sharply in one direction, predict the opposite.
 * Contrarian to momentum — bets on reversion to the mean.
 *
 * @param {Array} candles — signal window candles
 * @param {Object} opts — { threshold: minimum % move to trigger (default 0.1) }
 */
export function meanReversion(candles, opts = {}) {
    const threshold = opts.threshold ?? 0.1;
    if (candles.length === 0) return { direction: null, confidence: 0 };

    const openPrice = candles[0].open;
    const closePrice = candles[candles.length - 1].close;
    const pctChange = ((closePrice - openPrice) / openPrice) * 100;

    if (Math.abs(pctChange) < threshold) return { direction: null, confidence: 0 };

    // Predict opposite of observed move
    const direction = pctChange >= 0 ? 'DOWN' : 'UP';
    const confidence = Math.min(Math.abs(pctChange) / 0.5, 1);
    return { direction, confidence };
}

/**
 * Composite: combine momentum and taker buy ratio.
 * Only signals when both agree on direction.
 *
 * @param {Array} candles — signal window candles
 * @param {Object} opts — passed through to sub-signals
 */
export function composite(candles, opts = {}) {
    const mom = momentum(candles, { threshold: opts.momentumThreshold ?? 0.02 });
    const taker = takerBuyRatio(candles, {
        buyThreshold: opts.buyThreshold ?? 0.52,
        sellThreshold: opts.sellThreshold ?? 0.48,
    });

    if (!mom.direction || !taker.direction) return { direction: null, confidence: 0 };
    if (mom.direction !== taker.direction) return { direction: null, confidence: 0 };

    return {
        direction: mom.direction,
        confidence: (mom.confidence + taker.confidence) / 2,
    };
}

/**
 * Volume-Weighted Momentum: momentum weighted by volume profile.
 * Higher volume in the direction of the move = stronger signal.
 *
 * @param {Array} candles — signal window candles
 * @param {Object} opts — { threshold: 0 }
 */
export function volumeWeightedMomentum(candles, opts = {}) {
    const threshold = opts.threshold ?? 0;
    if (candles.length < 2) return { direction: null, confidence: 0 };

    let upVol = 0;
    let downVol = 0;
    for (const c of candles) {
        if (c.close >= c.open) {
            upVol += c.volume;
        } else {
            downVol += c.volume;
        }
    }

    const total = upVol + downVol;
    if (total === 0) return { direction: null, confidence: 0 };

    const ratio = upVol / total;
    const pctChange = ((candles[candles.length - 1].close - candles[0].open) / candles[0].open) * 100;

    if (Math.abs(pctChange) < threshold) return { direction: null, confidence: 0 };

    const direction = ratio >= 0.5 ? 'UP' : 'DOWN';
    const confidence = Math.min(Math.abs(ratio - 0.5) / 0.25, 1);
    return { direction, confidence };
}

/**
 * Order Book Imbalance signal.
 * Uses real-time depth data from Binance (OBI > 0 = buyers dominating).
 * Requires orderFlow data passed in opts.orderFlow.
 *
 * @param {Array} candles — signal window candles (used for price context)
 * @param {Object} opts — { orderFlow: { obi, obiAvg, cvd, buyVol, sellVol } }
 */
export function orderBookImbalance(candles, opts = {}) {
    const flow = opts.orderFlow;
    if (!flow) return { direction: null, confidence: 0 };

    const obi = flow.obiAvg ?? flow.obi ?? 0;
    const threshold = opts.threshold ?? 0.15;

    if (Math.abs(obi) < threshold) return { direction: null, confidence: 0 };

    const direction = obi > 0 ? 'UP' : 'DOWN';
    const confidence = Math.min(Math.abs(obi) / 0.5, 1);
    return { direction, confidence };
}

/**
 * Cumulative Volume Delta signal.
 * Positive CVD = aggressive buyers dominating, negative = sellers.
 * Requires orderFlow data passed in opts.orderFlow.
 *
 * @param {Array} candles — signal window candles (used for volume context)
 * @param {Object} opts — { orderFlow: { cvd, buyVol, sellVol, tradeCount } }
 */
export function cvdSignal(candles, opts = {}) {
    const flow = opts.orderFlow;
    if (!flow || flow.tradeCount < 10) return { direction: null, confidence: 0 };

    const totalVol = flow.buyVol + flow.sellVol;
    if (totalVol === 0) return { direction: null, confidence: 0 };

    // Buy ratio from tick-level data (more granular than kline takerBuyBaseVol)
    const buyRatio = flow.buyVol / totalVol;
    const cvdNorm = flow.cvd / totalVol; // normalized CVD

    const threshold = opts.threshold ?? 0.02;
    if (Math.abs(cvdNorm) < threshold) return { direction: null, confidence: 0 };

    const direction = flow.cvd > 0 ? 'UP' : 'DOWN';
    // Confidence from both buy ratio skew and CVD magnitude
    const ratioConf = Math.min(Math.abs(buyRatio - 0.5) / 0.2, 1);
    const cvdConf = Math.min(Math.abs(cvdNorm) / 0.1, 1);
    const confidence = (ratioConf + cvdConf) / 2;

    return { direction, confidence };
}

/**
 * Order Flow Composite: combines momentum + OBI + CVD + takerBuyRatio.
 * Weights: momentum 30%, OBI 25%, CVD 25%, takerBuyRatio 20%.
 * Only signals when at least 3 of 4 indicators agree on direction.
 *
 * @param {Array} candles — signal window candles
 * @param {Object} opts — { orderFlow, ... }
 */
export function orderFlowComposite(candles, opts = {}) {
    const mom   = momentum(candles, { threshold: opts.momentumThreshold ?? 0.02 });
    const taker = takerBuyRatio(candles, {
        buyThreshold: opts.buyThreshold ?? 0.52,
        sellThreshold: opts.sellThreshold ?? 0.48,
    });
    const obi = orderBookImbalance(candles, opts);
    const cvd = cvdSignal(candles, opts);

    const signals = [
        { sig: mom,   weight: 0.30 },
        { sig: obi,   weight: 0.25 },
        { sig: cvd,   weight: 0.25 },
        { sig: taker, weight: 0.20 },
    ];

    // Count agreement
    let upVotes = 0, downVotes = 0;
    let weightedConf = 0;
    let totalWeight = 0;

    for (const { sig, weight } of signals) {
        if (!sig.direction) continue;
        if (sig.direction === 'UP')   upVotes++;
        if (sig.direction === 'DOWN') downVotes++;
        weightedConf += sig.confidence * weight * (sig.direction === 'UP' ? 1 : -1);
        totalWeight += weight;
    }

    const agreeing = Math.max(upVotes, downVotes);
    // Require at least 3 of 4 signals to agree
    if (agreeing < (opts.minAgreement ?? 3)) return { direction: null, confidence: 0 };

    const direction = upVotes > downVotes ? 'UP' : 'DOWN';
    const rawConf = totalWeight > 0 ? Math.abs(weightedConf) / totalWeight : 0;
    const confidence = Math.min(rawConf, 1);

    return { direction, confidence };
}

/**
 * Instant Signal: fires at T+0 using only OBI and CVD — no 1-minute candle wait.
 * Designed for early entry before the Polymarket price has time to move.
 * Both OBI and CVD must agree on direction.
 *
 * @param {Array} candles — unused (signal is independent of candles)
 * @param {Object} opts — { orderFlow, obiThreshold, cvdThreshold }
 */
export function instantSignal(candles, opts = {}) {
    const flow = opts.orderFlow;
    if (!flow) return { direction: null, confidence: 0 };

    const obi = flow.obiAvg ?? flow.obi ?? 0;
    const totalVol = flow.buyVol + flow.sellVol;
    const cvdNorm = totalVol > 0 ? flow.cvd / totalVol : 0;

    const obiThreshold = opts.obiThreshold ?? 0.20;
    const cvdThreshold = opts.cvdThreshold ?? 0.03;

    const obiDir = Math.abs(obi) >= obiThreshold ? (obi > 0 ? 'UP' : 'DOWN') : null;
    const cvdDir = Math.abs(cvdNorm) >= cvdThreshold ? (flow.cvd > 0 ? 'UP' : 'DOWN') : null;

    if (!obiDir || !cvdDir || obiDir !== cvdDir) return { direction: null, confidence: 0 };

    const confidence = (Math.min(Math.abs(obi) / 0.5, 1) + Math.min(Math.abs(cvdNorm) / 0.1, 1)) / 2;
    return { direction: obiDir, confidence };
}

/**
 * Pre-Momentum Composite: combines pre-market Binance momentum with post-open OBI, CVD, and funding rate.
 * Key insight: BTC momentum from BEFORE the 15-min market opens predicts direction before
 * Polymarket price has time to reflect it — entering early at a lower price.
 *
 * Weights: pre-momentum 40%, OBI 25%, CVD 20%, post-open momentum 10%, funding rate 5%.
 * Requires majority agreement to signal.
 *
 * @param {Array} candles — post-open 1-min candles (may be empty for T+0 entry)
 * @param {Object} opts — { orderFlow, preCandles, fundingRate, preMomThreshold }
 *   preCandles: candles from BEFORE market open (use getCandlesBefore from binanceFeed)
 *   fundingRate: Binance perpetual funding rate (negative → UP bias, positive → DOWN)
 */
export function preMomentumComposite(candles, opts = {}) {
    const preCandles = opts.preCandles || [];
    const flow = opts.orderFlow;
    const fundingRate = opts.fundingRate ?? null;

    // Pre-market momentum direction (5 min before market opened)
    let preMomDir = null;
    let preMomConf = 0;
    if (preCandles.length >= 2) {
        const preMom = momentum(preCandles, { threshold: opts.preMomThreshold ?? 0.05 });
        preMomDir = preMom.direction;
        preMomConf = preMom.confidence;
    }

    // OBI and CVD at signal time
    const obiSig = orderBookImbalance([], { ...opts, orderFlow: flow });
    const cvdSig = cvdSignal([], { ...opts, orderFlow: flow });

    // Post-open candle momentum (if candles available)
    const momSig = candles.length >= 1
        ? momentum(candles, { threshold: 0.02 })
        : { direction: null, confidence: 0 };

    // Funding rate bias: negative = shorts paying longs = UP, positive = longs crowded = DOWN
    let fundingDir = null;
    if (fundingRate !== null && Math.abs(fundingRate) > 0.0001) {
        fundingDir = fundingRate < 0 ? 'UP' : 'DOWN';
    }

    const votes = [
        preMomDir ? { direction: preMomDir, confidence: preMomConf, weight: 0.40 } : null,
        obiSig.direction ? { direction: obiSig.direction, confidence: obiSig.confidence, weight: 0.25 } : null,
        cvdSig.direction ? { direction: cvdSig.direction, confidence: cvdSig.confidence, weight: 0.20 } : null,
        momSig.direction ? { direction: momSig.direction, confidence: momSig.confidence, weight: 0.10 } : null,
        fundingDir ? { direction: fundingDir, confidence: 0.5, weight: 0.05 } : null,
    ].filter(Boolean);

    if (votes.length < 2) return { direction: null, confidence: 0 };

    const upVotes = votes.filter((v) => v.direction === 'UP').length;
    const downVotes = votes.filter((v) => v.direction === 'DOWN').length;
    if (upVotes === downVotes) return { direction: null, confidence: 0 };

    const direction = upVotes > downVotes ? 'UP' : 'DOWN';
    const totalWeight = votes.reduce((s, v) => s + v.weight, 0);
    const weightedConf = votes
        .filter((v) => v.direction === direction)
        .reduce((s, v) => s + v.confidence * v.weight, 0);
    const confidence = Math.min(weightedConf / totalWeight, 1);

    return { direction, confidence };
}

export const ALL_SIGNALS = {
    momentum,
    takerBuyRatio,
    meanReversion,
    composite,
    volumeWeightedMomentum,
    orderBookImbalance,
    cvdSignal,
    orderFlowComposite,
    instantSignal,
    preMomentumComposite,
};
