/**
 * telegram.js — send CMM bot notifications to a Telegram chat.
 *
 * Credentials: reads TELEGRAM_TOKEN + TELEGRAM_CHAT_ID from .env
 * (same channel as weather-bot — copy those vars into polymarket-terminal/.env)
 */

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ENABLED = !!(TOKEN && CHAT_ID);

async function send(text) {
    if (!ENABLED) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
        });
        if (!res.ok) {
            const err = await res.text();
            console.error(`[Telegram] Send failed: ${err.slice(0, 100)}`);
        }
    } catch (err) {
        console.error(`[Telegram] Network error: ${err.message}`);
    }
}

/**
 * Periodic CMM performance report (sent 3x/day).
 * @param {object} stats - from getMMStats()
 * @param {string[]} timeframes - e.g. ['4h', '15m']
 */
export async function sendCmmReport(stats, timeframes) {
    if (!ENABLED) return;

    const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const pnl = stats.dailyPnl;
    const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    const pnlEmoji = pnl >= 0 ? '📈' : '📉';
    const wr = (stats.wins + stats.losses) > 0
        ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0) + '%'
        : 'n/a';

    const lines = [
        `${pnlEmoji} <b>CMM Report</b> — ${now}`,
        `  Timeframes: <b>${timeframes.join(', ')}</b>`,
        `  Daily PnL: <b>${pnlStr}</b>`,
        `  Fills: ${stats.fills} | W${stats.wins}/L${stats.losses} | WR ${wr}`,
        `  Rewards est: ~$${stats.dailyRewardEstimate.toFixed(2)}`,
    ];

    await send(lines.join('\n'));
}

/**
 * Weather bot: single trade fill notification.
 * @param {string} city
 * @param {object} trade - { tempC, isAbove, shares, price, edge, signalSource }
 * @param {boolean} isDryRun
 */
export async function sendWeatherFill(city, trade, isDryRun) {
    if (!ENABLED) return;
    const mode   = isDryRun ? '[SIM] ' : '';
    const bucket = `${trade.tempC}°C${trade.isAbove ? '+' : ''}`;
    const priceCents = (trade.price * 100).toFixed(1);
    const edgeCents  = (trade.edge  * 100).toFixed(1);
    const source = trade.signalSource === 'ml' ? '🤖 ML' : '🌦 NWP';
    const cost   = (trade.shares * trade.price).toFixed(2);
    const lines  = [
        `🎯 ${mode}<b>Weather Buy</b> — ${city.toUpperCase()}`,
        `  Bucket: <b>${bucket}</b> | ${trade.shares} shares @ ${priceCents}¢`,
        `  Edge: +${edgeCents}¢  |  Signal: ${source}`,
        `  Cost: $${cost}`,
    ];
    await send(lines.join('\n'));
}

/**
 * Weather bot: daily summary (open positions + settled results).
 * @param {object} state - { openPositions, settled, bankroll }
 */
export async function sendWeatherDailySummary(state) {
    if (!ENABLED) return;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    const wins = state.settled.filter(p => {
        if (p.winningTemp === null || p.winningTemp === undefined) return false;
        if (p.isAbove)  return p.winningTemp >= p.tempC;
        if (p.isBelow)  return p.winningTemp <= p.tempC;
        return p.winningTemp === p.tempC;
    }).length;
    const losses    = state.settled.length - wins;
    const totalCost = state.openPositions.reduce((s, p) => s + (p.cost || 0), 0);

    const lines = [
        `🌤 <b>Weather Bot — Daily Summary</b>`,
        `  ${now}`,
        `  Bankroll: <b>$${state.bankroll?.toFixed(2) ?? 'N/A'}</b>`,
        `  Open: ${state.openPositions.length} position(s) — $${totalCost.toFixed(2)} at risk`,
        `  Settled: ${state.settled.length} | W${wins}/L${losses}`,
    ];

    if (state.openPositions.length > 0) {
        lines.push(`\n  <b>Open positions:</b>`);
        for (const p of state.openPositions) {
            const bucket = `${p.tempC}°C${p.isAbove ? '+' : ''}`;
            lines.push(`    ${p.city.toUpperCase()}: ${bucket}  ${p.shares}sh  $${p.cost?.toFixed(2)}`);
        }
    }

    await send(lines.join('\n'));
}

/**
 * Hourly heartbeat — compact "alive" ping for dead-man switch.
 * Fires at non-stats hours (stats report covers 00/04/08/12/16/20 UTC).
 * @param {object} stats - from getMMStats()
 * @param {string} mode  - 'LIVE' or 'PAPER'
 */
export async function sendHeartbeat(stats, mode) {
    if (!ENABLED) return;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const pnlStr = (stats.dailyPnl >= 0 ? '+' : '') + '$' + stats.dailyPnl.toFixed(2);
    const lossFlag = stats.dailyLossHit ? ' ⚠️ LOSS LIMIT' : '';
    const lines = [
        `💚 <b>CMM [${mode}] alive</b> — ${now}${lossFlag}`,
        `  active=${stats.activeMarkets} | fills=${stats.fills} W${stats.wins}/L${stats.losses} | daily=${pnlStr}`,
    ];
    await send(lines.join('\n'));
}

export async function sendModelDegradationAlert(asset, reason) {
    if (!ENABLED) return;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const lines = [
        `🔴 <b>CMM ML MODEL DEGRADED</b> — ${asset.toUpperCase()}`,
        `  ${reason}`,
        `  ${now}`,
    ];
    await send(lines.join('\n'));
}

export async function sendFeedStalenessAlert(asset, staleDurationMs) {
    if (!ENABLED) return;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const durStr = staleDurationMs ? `${Math.round(staleDurationMs / 1000)}s` : 'unknown';
    const lines = [
        `🟡 <b>CMM FEED STALE</b> — ${asset.toUpperCase()}`,
        `  No data for ${durStr}`,
        `  ${now}`,
    ];
    await send(lines.join('\n'));
}

export { ENABLED };
