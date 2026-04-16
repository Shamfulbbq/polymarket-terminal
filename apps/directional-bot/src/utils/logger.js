// ANSI color codes (used in normal terminal mode)
const A = {
    reset:   '\x1b[0m',
    dim:     '\x1b[2m',
    red:     '\x1b[31m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    blue:    '\x1b[34m',
    magenta: '\x1b[35m',
    cyan:    '\x1b[36m',
};

// Blessed tag pairs (used when dashboard is active)
const B = {
    red:     ['{red-fg}',     '{/red-fg}'],
    green:   ['{green-fg}',   '{/green-fg}'],
    yellow:  ['{yellow-fg}',  '{/yellow-fg}'],
    blue:    ['{blue-fg}',    '{/blue-fg}'],
    magenta: ['{magenta-fg}', '{/magenta-fg}'],
    cyan:    ['{cyan-fg}',    '{/cyan-fg}'],
};

let outputFn = null; // When set, all log goes here (blessed dashboard mode)

function ts() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function stringify(args) {
    return args.map((a) => (a && typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
}

function log(ansiColor, bColor, emoji, level, ...args) {
    const msg = stringify(args);
    if (outputFn) {
        const [open, close] = bColor;
        outputFn(`{gray-fg}[${ts()}]{/gray-fg} ${open}${emoji} ${level}${close} ${msg}`);
    } else {
        process.stdout.write(
            `${A.dim}[${ts()}]${A.reset} ${ansiColor}${emoji} ${level}${A.reset} ${msg}\n`,
        );
    }
}

const logger = {
    info:    (...a) => log(A.blue,    B.blue,    'ℹ️ ', 'INFO',    ...a),
    success: (...a) => log(A.green,   B.green,   '✅', 'SUCCESS', ...a),
    warn:    (...a) => log(A.yellow,  B.yellow,  '⚠️ ', 'WARN',    ...a),
    error:   (...a) => log(A.red,     B.red,     '❌', 'ERROR',   ...a),
    trade:   (...a) => log(A.magenta, B.magenta, '📊', 'TRADE',   ...a),
    watch:   (...a) => log(A.cyan,    B.cyan,    '👀', 'WATCH',   ...a),
    money:   (...a) => log(A.green,   B.green,   '💰', 'MONEY',   ...a),

    /** Call once after initDashboard() to redirect all logs to the TUI */
    setOutput(fn) {
        outputFn = fn;
    },
};

export default logger;
