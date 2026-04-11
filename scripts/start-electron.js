#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const electronBinary = require('electron');

const appRoot = path.resolve(__dirname, '..');
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
    env.ELECTRON_DISABLE_SANDBOX = env.ELECTRON_DISABLE_SANDBOX || '1';
}

const child = spawn(electronBinary, [appRoot, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
    cwd: appRoot,
    windowsHide: false,
});

child.on('close', (code, signal) => {
    if (code == null) {
        console.error(`${electronBinary} exited with signal`, signal);
        process.exit(1);
    }
    process.exit(code);
});

['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
        if (!child.killed) child.kill(signal);
    });
});
