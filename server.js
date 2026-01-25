'use strict';
const http = require('http');
const { initDatabase, seedDatabase, closeDatabase } = require('./db');
const { handleRoutes } = require('./routes');
const { getInternalIpAddress } = require('./utils/network');
const { waitForValidApiKey, hasApiKey } = require('./utils/apiKey');
const { startConnectionLoop, stopConnectionLoop } = require('./controllers/subscriptionController');
const { closeAllConnections } = require('./controllers/streamController');

const PORT = 3000;

/**
 * Main request handler
 */
async function handleRequest(req, res) {
    try {
        const handled = await handleRoutes(req, res);
        
        if (!handled) {
            // 404 for unmatched routes
            res.writeHead(404);
            res.end('Not Found');
        }
    } catch (error) {
        console.error('Request error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Create server
const server = http.createServer(handleRequest);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    stopConnectionLoop();
    closeAllConnections();
    closeDatabase();
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...');
    stopConnectionLoop();
    closeAllConnections();
    closeDatabase();
    server.close(() => {
        process.exit(0);
    });
});

// Initialize and start
async function start() {
    await initDatabase();
    await seedDatabase();
    const ip = getInternalIpAddress();

    console.log(`\n========================================`);
    console.log(`  TSW HUD Project Server`);
    console.log(`========================================`);

    // Wait for API key before starting server
    console.log('Checking for TSW CommAPI key...');
    const apiKey = await waitForValidApiKey();

    if (!apiKey) {
        console.error('ERROR: Could not load API key. Server cannot start.');
        process.exit(1);
    }

    // Start TSW connection loop (will retry every 30 seconds until connected)
    console.log('Starting TSW connection manager...');
    startConnectionLoop();

    server.listen(PORT, () => {
        console.log(`========================================`);
        console.log(`  Local:   http://127.0.0.1:${PORT}`);
        console.log(`  Network: http://${ip}:${PORT}`);
        console.log(`========================================`);
        console.log(`  Pages:`);
        console.log(`    /        - Main index`);
        console.log(`    /hud     - Live HUD dashboard`);
        console.log(`    /map     - Live route map`);
        console.log(`    /weather - Weather control`);
        console.log(`========================================`);
        console.log(`  Press Ctrl+C to stop`);
        console.log(`========================================\n`);
    });
}

start();
