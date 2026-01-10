/**
 * Package the app as a portable bundle with embedded Node.js
 * No installation required - just download, extract, and run start.bat
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIST_DIR = path.join(__dirname, 'portable');
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
    console.log('  Creating Portable Bundle');
    console.log('='.repeat(50));
    
    // Clean and create dist directory
    if (fs.existsSync(DIST_DIR)) {
        console.log('\nCleaning previous build...');
        fs.rmSync(DIST_DIR, { recursive: true });
    }
    fs.mkdirSync(DIST_DIR, { recursive: true });
    
    // Create app directory
    const appDir = path.join(DIST_DIR, 'app');
    fs.mkdirSync(appDir);
    
    // Copy app files
    console.log('\n1. Copying app files...');
    const filesToCopy = [
        'server.js',
        'ocr.js', 
        'package.json',
        'package-lock.json'
    ];
    
    for (const file of filesToCopy) {
        const src = path.join(__dirname, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(appDir, file));
            console.log(`   ✓ ${file}`);
        }
    }
    
    // Copy public folder
    if (fs.existsSync(path.join(__dirname, 'public'))) {
        copyFolderSync(path.join(__dirname, 'public'), path.join(appDir, 'public'));
        console.log('   ✓ public/');
    }
    
    // Copy node_modules (needed for Sharp and other native modules)
    console.log('\n2. Copying node_modules (this may take a moment)...');
    copyFolderSync(
        path.join(__dirname, 'node_modules'), 
        path.join(appDir, 'node_modules'),
        ['.cache', '.package-lock.json']
    );
    console.log('   ✓ node_modules/');
    
    // Create start.bat
    console.log('\n3. Creating launcher scripts...');
    const startBat = `@echo off
title TSW HUD Dashboard
cd /d "%~dp0"
echo.
echo ========================================
echo   TSW HUD Dashboard
echo ========================================
echo.
echo Starting server...
echo.

"node\\node.exe" "app\\server.js"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Error starting server. Press any key to exit.
    pause >nul
)
`;
    fs.writeFileSync(path.join(DIST_DIR, 'TSW_HUD_Start.bat'), startBat);
    console.log('   ✓ TSW_HUD_Start.bat');
    
    // Create README
    console.log('\n4. Creating README...');
    const readme = `TSW HUD Dashboard - Portable Edition
=====================================

QUICK START
-----------
1. Double-click "TSW_HUD_Start.bat"
2. Wait for the server to start (you'll see "Press Ctrl+C to stop")
3. Open your browser to: http://localhost:3000
4. That's it!

FEATURES
--------
- Extract timetables from screenshots using OCR
- Manage routes and timetables
- Works offline
- No installation required

USAGE
-----
1. Go to http://localhost:3000/extract.html
2. Upload your timetable screenshots
3. The OCR will extract the data automatically
4. Edit any errors in the table
5. Save to database

TROUBLESHOOTING
---------------
- If Windows shows "Windows protected your PC":
  Click "More info" then "Run anyway"
  
- If the server doesn't start:
  Make sure you extracted ALL files from the zip
  Don't move files out of this folder
  
- If OCR is inaccurate:
  Take clear screenshots with good contrast
  The first image should show the service name banner

STOPPING THE SERVER
-------------------
Press Ctrl+C in the command window, or just close the window.

`;
    fs.writeFileSync(path.join(DIST_DIR, 'README.txt'), readme);
    console.log('   ✓ README.txt');
    
    // Download Node.js
    console.log('\n5. Downloading portable Node.js...');
    console.log('   This may take a minute (~30MB download)');
    
    const nodeZip = path.join(DIST_DIR, 'node.zip');
    
    try {
        // Use PowerShell to download
        execSync(`powershell -Command "Invoke-WebRequest -Uri '${NODE_URL}' -OutFile '${nodeZip}'"`, {
            stdio: 'inherit'
        });
        console.log('   ✓ Downloaded node.zip');
        
        // Extract using PowerShell
        console.log('\n6. Extracting Node.js...');
        execSync(`powershell -Command "Expand-Archive -Path '${nodeZip}' -DestinationPath '${DIST_DIR}' -Force"`, {
            stdio: 'inherit'
        });
        
        // Rename extracted folder to 'node'
        const extractedName = `node-v${NODE_VERSION}-win-x64`;
        const extractedPath = path.join(DIST_DIR, extractedName);
        const nodePath = path.join(DIST_DIR, 'node');
        
        if (fs.existsSync(extractedPath)) {
            fs.renameSync(extractedPath, nodePath);
            console.log('   ✓ Extracted to node/');
        }
        
        // Clean up zip
        fs.unlinkSync(nodeZip);
        console.log('   ✓ Cleaned up');
        
    } catch (error) {
        console.error('   ✗ Failed to download Node.js');
        console.error('   Please download manually from:', NODE_URL);
        console.error('   Extract to:', path.join(DIST_DIR, 'node'));
        return;
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
    getSize(DIST_DIR);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
    
    console.log('\n' + '='.repeat(50));
    console.log('  ✓ Portable bundle created!');
    console.log('='.repeat(50));
    console.log(`\nLocation: ${DIST_DIR}`);
    console.log(`Size: ${sizeMB} MB`);
    console.log('\nTo distribute:');
    console.log('1. Zip the "portable" folder');
    console.log('2. Share the zip file (e.g., on GitHub releases)');
    console.log('3. Users just extract and double-click TSW_HUD_Start.bat');
}

main().catch(console.error);
