/**
 * Build the runtime folder with embedded Node.js and node_modules
 * 
 * This only needs to be run when:
 * - First time setup for portable distribution
 * - After adding/updating npm packages
 * 
 * Code changes do NOT require rebuilding!
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RUNTIME_DIR = path.join(__dirname, 'runtime');
const NODE_VERSION = '18.19.0'; // LTS version
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;

function copyFolderSync(src, dest, exclude = []) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
        if (exclude.includes(entry.name)) continue;
        
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
            copyFolderSync(srcPath, destPath, exclude);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

async function main() {
    console.log('='.repeat(50));
    console.log('  Building Embedded Runtime');
    console.log('='.repeat(50));
    console.log('\nThis creates runtime/ with Node.js + node_modules');
    console.log('Code stays in root - no duplication!\n');
    
    // Clean and create runtime directory
    if (fs.existsSync(RUNTIME_DIR)) {
        console.log('Cleaning previous runtime...');
        fs.rmSync(RUNTIME_DIR, { recursive: true });
    }
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    
    // Copy node_modules
    console.log('\n1. Copying node_modules (this may take a moment)...');
    if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
        console.error('   ✗ node_modules not found! Run "npm install" first.');
        process.exit(1);
    }
    copyFolderSync(
        path.join(__dirname, 'node_modules'), 
        path.join(RUNTIME_DIR, 'node_modules'),
        ['.cache', '.package-lock.json']
    );
    console.log('   ✓ node_modules/');
    
    // Download Node.js
    console.log('\n2. Downloading portable Node.js...');
    console.log('   This may take a minute (~30MB download)');
    
    const nodeZip = path.join(RUNTIME_DIR, 'node.zip');
    
    try {
        // Use PowerShell to download
        execSync(`powershell -Command "Invoke-WebRequest -Uri '${NODE_URL}' -OutFile '${nodeZip}'"`, {
            stdio: 'inherit'
        });
        console.log('   ✓ Downloaded node.zip');
        
        // Extract using PowerShell
        console.log('\n3. Extracting Node.js...');
        execSync(`powershell -Command "Expand-Archive -Path '${nodeZip}' -DestinationPath '${RUNTIME_DIR}' -Force"`, {
            stdio: 'inherit'
        });
        
        // The zip extracts to a subfolder, we need node.exe in runtime root
        const extractedName = `node-v${NODE_VERSION}-win-x64`;
        const extractedPath = path.join(RUNTIME_DIR, extractedName);
        
        if (fs.existsSync(extractedPath)) {
            // Copy node.exe to runtime root
            fs.copyFileSync(
                path.join(extractedPath, 'node.exe'),
                path.join(RUNTIME_DIR, 'node.exe')
            );
            // Remove the extracted folder (we only need node.exe)
            fs.rmSync(extractedPath, { recursive: true });
            console.log('   ✓ Extracted node.exe');
        }
        
        // Clean up zip
        fs.unlinkSync(nodeZip);
        console.log('   ✓ Cleaned up');
        
    } catch (error) {
        console.error('   ✗ Failed to download Node.js');
        console.error('   Please download manually from:', NODE_URL);
        console.error('   Extract node.exe to:', RUNTIME_DIR);
        return;
    }
    
    // Copy eng.traineddata for OCR
    if (fs.existsSync(path.join(__dirname, 'eng.traineddata'))) {
        fs.copyFileSync(
            path.join(__dirname, 'eng.traineddata'),
            path.join(RUNTIME_DIR, 'eng.traineddata')
        );
        console.log('   ✓ eng.traineddata');
    }
    
    // Calculate size
    let totalSize = 0;
    function getSize(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                getSize(fullPath);
            } else {
                totalSize += fs.statSync(fullPath).size;
            }
        }
    }
    getSize(RUNTIME_DIR);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
    
    console.log('\n' + '='.repeat(50));
    console.log('  ✓ Runtime built successfully!');
    console.log('='.repeat(50));
    console.log(`\nLocation: ${RUNTIME_DIR}`);
    console.log(`Size: ${sizeMB} MB`);
    console.log('\nUsage:');
    console.log('  - Double-click TSW_HUD_Start.bat (uses embedded node)');
    console.log('  - Or run: node server.js (uses system node)');
    console.log('\nRebuild runtime when:');
    console.log('  - You add new npm packages');
    console.log('  - You update npm packages');
    console.log('\nCode changes do NOT require rebuilding!');
}

main().catch(console.error);
