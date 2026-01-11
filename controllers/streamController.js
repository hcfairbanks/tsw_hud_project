'use strict';
const { getTelemetryData } = require('./telemetryController');

// Track active SSE connections
const activeConnections = new Set();

/**
 * Handle SSE stream request
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleStream(req, res) {
    // Set SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    console.log('Starting live telemetry stream...');
    activeConnections.add(res);

    // Send data every 500ms
    const interval = setInterval(async () => {
        try {
            const streamData = await getTelemetryData();
            res.write(`data: ${JSON.stringify(streamData)}\n\n`);
        } catch (err) {
            res.write(`data: {"error": "Failed to fetch TSW data: ${err.message}"}\n\n`);
        }
    }, 500);

    // Cleanup on connection close
    req.on('close', () => {
        clearInterval(interval);
        activeConnections.delete(res);
        console.log('SSE connection closed');
    });

    // Send initial keepalive
    res.write(': keepalive\n\n');
}

/**
 * Send data to all active connections
 * @param {object} data
 */
function broadcastToAll(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of activeConnections) {
        try {
            res.write(message);
        } catch (err) {
            // Connection might be closed
            activeConnections.delete(res);
        }
    }
}

/**
 * Get number of active connections
 * @returns {number}
 */
function getActiveConnectionCount() {
    return activeConnections.size;
}

/**
 * Close all active connections
 */
function closeAllConnections() {
    for (const res of activeConnections) {
        try {
            res.end();
        } catch (err) {
            // Ignore errors during cleanup
        }
    }
    activeConnections.clear();
}

module.exports = {
    handleStream,
    broadcastToAll,
    getActiveConnectionCount,
    closeAllConnections
};
