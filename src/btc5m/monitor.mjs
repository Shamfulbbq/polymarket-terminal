/**
 * monitor.mjs
 * Local monitor for the btc5m bot running on Ireland server.
 *
 * Tails the remote bot log in real-time via SSH, watches for error patterns,
 * and can kill the tmux session immediately — either automatically on critical
 * errors or manually on keypress.
 *
 * Usage (run locally):
 *   node src/btc5m/monitor.mjs
 *
 * Controls:
 *   s + Enter  → emergency stop (kill btc5m_bot tmux session on Ireland)
 *   q + Enter  → quit monitor (bot keeps running)
 *   Ctrl+C     → quit monitor (bot keeps running)
 */

import { spawn, execSync } from 'child_process';
import readline from 'readline';

const KEY  = 'C:/Users/makeo/polymarket_bot/poly.pem';
const HOST = 'ubuntu@108.131.218.78';
const LOG  = '~/polymarket-terminal/data/btc5m/bot.log';
const SESSION = 'btc5m_bot';

// ── Auto-stop triggers ─────────────────────────────────────────────────────
// Any line matching these patterns causes an immediate emergency stop.
const FATAL_PATTERNS = [
    /btc5m fatal/i,
    /process\.exit/i,
    /ECONNREFUSED.*clob\.polymarket/i,
];

// If this many consecutive order rejections happen, auto-stop.
const MAX_CONSECUTIVE_REJECTIONS = 5;

// If daily PnL loss exceeds this (extracted from logs), auto-stop.
// Match this to BTC5M_DAILY_LOSS_LIMIT in .env.btc5m so the monitor
// fires at the same threshold as the bot's own kill switch.
// Note: PnL here is simulation-based — verify real loss on Polymarket UI.
const LOCAL_LOSS_LIMIT = 10; // USDC — matches BTC5M_DAILY_LOSS_LIMIT

// ── State ──────────────────────────────────────────────────────────────────
let consecutiveRejections = 0;
let stopped = false;
let roundCount = 0;
let lastPnl = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function ts() {
    return new Date().toISOString().slice(11, 19);
}

function alert(msg) {
    process.stdout.write(`\n\x1b[31m[${ts()}] ⚠  ${msg}\x1b[0m\n`);
}

function info(msg) {
    process.stdout.write(`\x1b[36m[${ts()}] ${msg}\x1b[0m\n`);
}

function good(msg) {
    process.stdout.write(`\x1b[32m[${ts()}] ${msg}\x1b[0m\n`);
}

function emergencyStop(reason) {
    if (stopped) return;
    stopped = true;
    alert(`EMERGENCY STOP — ${reason}`);
    alert(`Killing tmux session '${SESSION}' on Ireland...`);
    try {
        execSync(
            `ssh -i "${KEY}" -o StrictHostKeyChecking=no ${HOST} "tmux kill-session -t ${SESSION} 2>/dev/null; echo killed"`,
            { timeout: 10000 }
        );
        good(`Session '${SESSION}' killed. Bot stopped.`);
    } catch (e) {
        alert(`Kill command failed: ${e.message}`);
        alert(`Run manually: ssh -i "${KEY}" ${HOST} 'tmux kill-session -t ${SESSION}'`);
    }
    process.exit(1);
}

// ── Log line parser ────────────────────────────────────────────────────────

function parseLine(line) {
    // Strip ANSI codes and logger prefix noise for clean display
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean) return;

    // Fatal pattern check
    for (const pat of FATAL_PATTERNS) {
        if (pat.test(clean)) {
            emergencyStop(`Fatal pattern detected: ${clean.slice(0, 120)}`);
            return;
        }
    }

    // Order rejection counter
    if (/rejected.*—|place error/.test(clean)) {
        consecutiveRejections++;
        alert(`Order rejected (${consecutiveRejections}/${MAX_CONSECUTIVE_REJECTIONS}): ${clean.slice(0, 100)}`);
        if (consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
            emergencyStop(`${MAX_CONSECUTIVE_REJECTIONS} consecutive order rejections — wallet likely unfunded or API down`);
        }
        return;
    }

    // Reset rejection counter on any successful order placement
    if (/placed (UP|DN)/.test(clean)) {
        consecutiveRejections = 0;
    }

    // New round detection
    if (/NEW ROUND/.test(clean)) {
        roundCount++;
        info(`Round ${roundCount}: ${clean.slice(clean.indexOf('NEW ROUND'))}`);
        return;
    }

    // Hedge triggered
    if (/HEDGE TRIGGERED/.test(clean)) {
        good(`🔒 ${clean.slice(clean.indexOf('HEDGE'))}`);
        return;
    }

    // Resolve with PnL
    if (/resolved (UP|DN)/.test(clean)) {
        // Extract daily PnL from line: daily=X.XX
        const dailyMatch = clean.match(/daily=([-\d.]+)/);
        if (dailyMatch) {
            lastPnl = parseFloat(dailyMatch[1]);
            const pnlColor = lastPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
            process.stdout.write(`${pnlColor}[${ts()}] RESOLVED: daily_pnl=$${lastPnl.toFixed(2)}\x1b[0m\n`);

            if (LOCAL_LOSS_LIMIT > 0 && lastPnl < -LOCAL_LOSS_LIMIT) {
                emergencyStop(`Local loss limit hit: daily_pnl=$${lastPnl.toFixed(2)} < -$${LOCAL_LOSS_LIMIT}`);
            }
        }
        return;
    }

    // Poll status (show briefly — one line, no newline to reduce noise)
    if (/poll up_ask/.test(clean)) {
        const match = clean.match(/poll (.+)/);
        if (match) process.stdout.write(`\r\x1b[33m[${ts()}] ${match[1].slice(0, 80).padEnd(80)}\x1b[0m`);
        return;
    }

    // Warnings — always show
    if (/warn|error|skipping|gave up|failed/i.test(clean)) {
        alert(clean.slice(0, 140));
        return;
    }

    // Everything else — show in dim
    process.stdout.write(`\x1b[2m[${ts()}] ${clean.slice(0, 140)}\x1b[0m\n`);
}

// ── SSH tail ───────────────────────────────────────────────────────────────

function startTail() {
    info(`Connecting to ${HOST} and tailing ${LOG}...`);

    const ssh = spawn('ssh', [
        '-i', KEY,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=15',
        HOST,
        `tail -n 50 -f ${LOG}`,
    ]);

    let buf = '';
    ssh.stdout.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line
        for (const line of lines) parseLine(line);
    });

    ssh.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg) alert(`SSH: ${msg}`);
    });

    ssh.on('close', code => {
        if (!stopped) {
            alert(`SSH connection lost (code ${code}). Reconnecting in 5s...`);
            setTimeout(startTail, 5000);
        }
    });

    ssh.on('error', err => {
        alert(`SSH error: ${err.message}. Reconnecting in 5s...`);
        setTimeout(startTail, 5000);
    });
}

// ── Keyboard input ─────────────────────────────────────────────────────────

function setupKeyboard() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') {
            info('Monitor exiting (bot still running on server).');
            process.exit(0);
        }
        if (str === 's' || str === 'S') {
            emergencyStop('Manual stop triggered (pressed s)');
        }
        if (str === 'q' || str === 'Q') {
            info('Monitor exiting (bot still running on server).');
            process.exit(0);
        }
    });
}

// ── Main ───────────────────────────────────────────────────────────────────

process.stdout.write('\x1b[2J\x1b[H'); // clear screen
info('btc5m local monitor started');
info(`Watching: ${HOST}:${LOG}`);
info(`Auto-stop triggers: ${MAX_CONSECUTIVE_REJECTIONS} rejections | loss > $${LOCAL_LOSS_LIMIT} | fatal error`);
info('Controls: [s] emergency stop   [q] quit monitor   [Ctrl+C] quit monitor');
process.stdout.write('─'.repeat(80) + '\n');

setupKeyboard();
startTail();
