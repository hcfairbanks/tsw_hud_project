/**
 * Build script for TSW HUD Project
 * Copies necessary files alongside the exe for tesseract.js to work
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, 'dist');
const nodeModules = path.join(__dirname, 'node_modules');

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

// Copy sql-wasm.wasm
const wasmSrc = path.join(nodeModules, 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmDest = path.join(distDir, 'sql-wasm.wasm');
if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, wasmDest);
    console.log('✓ Copied sql-wasm.wasm');
}

function copyDirRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Copy complete tesseract.js and tesseract.js-core packages to node_modules in dist
const distNodeModules = path.join(distDir, 'node_modules');
if (!fs.existsSync(distNodeModules)) {
    fs.mkdirSync(distNodeModules, { recursive: true });
}

// Copy tesseract.js
const tesseractSrc = path.join(nodeModules, 'tesseract.js');
const tesseractDest = path.join(distNodeModules, 'tesseract.js');
if (fs.existsSync(tesseractSrc)) {
    copyDirRecursive(tesseractSrc, tesseractDest);
    console.log('✓ Copied tesseract.js package');
}

// Copy tesseract.js-core
const tesseractCoreSrc = path.join(nodeModules, 'tesseract.js-core');
const tesseractCoreDest = path.join(distNodeModules, 'tesseract.js-core');
if (fs.existsSync(tesseractCoreSrc)) {
    copyDirRecursive(tesseractCoreSrc, tesseractCoreDest);
    console.log('✓ Copied tesseract.js-core package');
}

// Copy bmp-js (dependency of tesseract.js)
const bmpJsSrc = path.join(nodeModules, 'bmp-js');
const bmpJsDest = path.join(distNodeModules, 'bmp-js');
if (fs.existsSync(bmpJsSrc)) {
    copyDirRecursive(bmpJsSrc, bmpJsDest);
    console.log('✓ Copied bmp-js package');
}

// Copy idb-keyval (dependency of tesseract.js)
const idbSrc = path.join(nodeModules, 'idb-keyval');
const idbDest = path.join(distNodeModules, 'idb-keyval');
if (fs.existsSync(idbSrc)) {
    copyDirRecursive(idbSrc, idbDest);
    console.log('✓ Copied idb-keyval package');
}

// Copy zlibjs (dependency of tesseract.js)
const zlibjsSrc = path.join(nodeModules, 'zlibjs');
const zlibjsDest = path.join(distNodeModules, 'zlibjs');
if (fs.existsSync(zlibjsSrc)) {
    copyDirRecursive(zlibjsSrc, zlibjsDest);
    console.log('✓ Copied zlibjs package');
}

// Copy node-fetch if it exists (might be needed)
const nodeFetchSrc = path.join(nodeModules, 'node-fetch');
const nodeFetchDest = path.join(distNodeModules, 'node-fetch');
if (fs.existsSync(nodeFetchSrc)) {
    copyDirRecursive(nodeFetchSrc, nodeFetchDest);
    console.log('✓ Copied node-fetch package');
}

// Copy views folder
const viewsSrc = path.join(__dirname, 'views');
const viewsDest = path.join(distDir, 'views');
if (fs.existsSync(viewsSrc)) {
    copyDirRecursive(viewsSrc, viewsDest);
    console.log('✓ Copied views folder');
}

// Build the exe
console.log('\nBuilding executable...');
try {
    execSync('npx pkg . --targets node18-win-x64 --output dist/tsw-hud.exe', {
        cwd: __dirname,
        stdio: 'inherit'
    });
    console.log('\n✓ Build complete!');
    console.log(`  Executable: ${path.join(distDir, 'tsw-hud.exe')}`);
} catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
}
