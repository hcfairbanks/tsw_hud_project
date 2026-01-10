'use strict';
const http = require('http');
const { initDatabase, seedDatabase, closeDatabase } = require('./db');
const { handleRoutes } = require('./routes');
const { getInternalIpAddress } = require('./utils/network');

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
    closeDatabase();
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...');
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

    server.listen(PORT, () => {
        console.log(`\n========================================`);
        console.log(`  TSW HUD Project Server`);
        console.log(`========================================`);
        console.log(`  Local:   http://localhost:${PORT}`);
        console.log(`  Network: http://${ip}:${PORT}`);
        console.log(`========================================`);
        console.log(`  Press Ctrl+C to stop`);
        console.log(`========================================\n`);
    });
}

start();
