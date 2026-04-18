#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const entryPath = path.resolve(rootDir, packageJson.main || 'main.js');

const visitedFiles = new Set();
const missingModules = [];

const patterns = [
    /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /import\s+[^'"]*?\s+from\s+['"`]([^'"`]+)['"`]/g,
    /import\(\s*['"`]([^'"`]+)['"`]\s*\)/g
];

function normalizeFile(filePath) {
    return path.normalize(filePath);
}

function isLocalSpecifier(specifier) {
    return specifier.startsWith('./') || specifier.startsWith('../');
}

function isScriptFile(filePath) {
    return /\.(c?js|mjs)$/i.test(filePath);
}

function collectSpecifiers(source) {
    const specifiers = new Set();
    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source))) {
            if (isLocalSpecifier(match[1])) specifiers.add(match[1]);
        }
    }
    return [...specifiers];
}

function scanFile(filePath) {
    const normalizedPath = normalizeFile(filePath);
    if (visitedFiles.has(normalizedPath) || !fs.existsSync(normalizedPath) || !isScriptFile(normalizedPath)) return;
    visitedFiles.add(normalizedPath);

    const source = fs.readFileSync(normalizedPath, 'utf8');
    const localRequire = createRequire(normalizedPath);

    for (const specifier of collectSpecifiers(source)) {
        let resolvedPath;
        try {
            resolvedPath = localRequire.resolve(specifier);
        } catch (error) {
            missingModules.push({
                from: path.relative(rootDir, normalizedPath),
                specifier,
                error: error.message
            });
            continue;
        }

        if (!resolvedPath.startsWith(rootDir)) continue;
        scanFile(resolvedPath);
    }
}

scanFile(entryPath);

if (missingModules.length) {
    console.error('Missing local modules referenced by the Electron entry graph:');
    for (const item of missingModules) {
        console.error(`- ${item.from} -> ${item.specifier}`);
    }
    process.exit(1);
}

console.log(`Verified local module graph for ${path.relative(rootDir, entryPath)} (${visitedFiles.size} files).`);
