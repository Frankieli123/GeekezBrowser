const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, `app-${new Date().toISOString().split('T')[0]}.log`);

fs.ensureDirSync(LOG_DIR);

function formatLog(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}\n`;
}

function writeLog(level, message, meta) {
    const logLine = formatLog(level, message, meta);
    console.log(logLine.trim());
    try {
        fs.appendFileSync(LOG_FILE, logLine);
    } catch (e) {}
}

module.exports = {
    error: (msg, meta) => writeLog('ERROR', msg, meta),
    warn: (msg, meta) => writeLog('WARN', msg, meta),
    info: (msg, meta) => writeLog('INFO', msg, meta)
};
