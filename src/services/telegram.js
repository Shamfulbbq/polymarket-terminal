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

export { ENABLED };
