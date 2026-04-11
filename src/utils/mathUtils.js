/**
 * Shared math utilities for CMM signal processing and backtesting.
 * Pure functions — no I/O, no side effects.
 */

/**
 * Sample standard deviation (Bessel-corrected).
 * Returns 0 for arrays with fewer than 2 elements.
 */
export function std(arr) {
    if (!arr || arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const varSum = arr.reduce((a, b) => a + (b - mean) ** 2, 0);
    return Math.sqrt(varSum / Math.max(1, arr.length - 1));
}

/**
 * Lag-1 autocorrelation (Pearson correlation between arr[1:] and arr[:-1]).
 * Returns 0 for arrays with fewer than 3 elements.
 */
export function corrLag1(arr) {
    if (!arr || arr.length < 3) return 0;
    const x = arr.slice(1);
    const y = arr.slice(0, -1);
    const mx = x.reduce((a, b) => a + b, 0) / x.length;
    const my = y.reduce((a, b) => a + b, 0) / y.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < x.length; i++) {
        const vx = x[i] - mx;
        const vy = y[i] - my;
        num += vx * vy;
        dx += vx * vx;
        dy += vy * vy;
    }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/**
 * Fractional differencing (Fixed-width FFD, Lopez de Prado).
 * Matches training: d=0.35, th=1e-4, max_k=200.
 * Input: array of close prices (log-transformed), newest last.
 * Returns scalar or 0.0 if insufficient data.
 */
export function fracDiffClose(closes) {
    const d = 0.35, th = 1e-4, maxK = 200;
    const w = [1.0];
    for (let k = 1; k < maxK; k++) {
        const wn = -w[w.length - 1] * (d - k + 1) / k;
        if (Math.abs(wn) <= th) break;
        w.push(wn);
    }
    if (closes.length < w.length) return 0.0;
    const n = closes.length;
    const wLen = w.length;
    let result = 0.0;
    for (let i = 0; i < wLen; i++) {
        result += w[wLen - 1 - i] * closes[n - wLen + i];
    }
    return result;
}
