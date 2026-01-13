'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson, parseBody } = require('../utils/http');
const { getRouteData, loadRouteFromFile, loadRouteFromData, clearRoute } = require('./telemetryController');

// Get the app directory
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

/**
 * List available routes
 */
async function listRoutes(req, res) {
    try {
        const processedRoutesDir = path.join(appDir, 'processed_routes');
        const unprocessedRoutesDir = path.join(appDir, 'unprocessed_routes');

        const routes = {
            processed: [],
            unprocessed: []
        };

        // Get processed routes
        if (fs.existsSync(processedRoutesDir)) {
            routes.processed = fs.readdirSync(processedRoutesDir)
                .filter(f => f.startsWith('route_') && f.endsWith('.json'))
                .map(filename => ({
                    filename: filename,
                    name: filename.replace('route_', '').replace('.json', ''),
                    type: 'processed'
                }));
        }

        // Get unprocessed routes
        if (fs.existsSync(unprocessedRoutesDir)) {
            routes.unprocessed = fs.readdirSync(unprocessedRoutesDir)
                .filter(f => f.startsWith('route_') && f.endsWith('.json'))
                .map(filename => ({
                    filename: filename,
                    name: filename.replace('route_', '').replace('.json', ''),
                    type: 'unprocessed'
                }));
        }

        sendJson(res, routes);
    } catch (err) {
        sendJson(res, { error: err.message }, 500);
    }
}

/**
 * Browse directory for route files
 */
async function browseDirectory(req, res, requestedPath) {
    try {
        let browsePath;
        if (!requestedPath) {
            browsePath = appDir;
        } else {
            browsePath = path.join(appDir, requestedPath);
            // Security check
            if (!browsePath.startsWith(appDir)) {
                sendJson(res, { error: 'Access denied' }, 403);
                return;
            }
        }

        if (!fs.existsSync(browsePath)) {
            sendJson(res, { error: 'Path not found' }, 404);
            return;
        }

        const stats = fs.statSync(browsePath);
        if (!stats.isDirectory()) {
            sendJson(res, { error: 'Path is not a directory' }, 400);
            return;
        }

        const items = fs.readdirSync(browsePath).map(item => {
            const fullPath = path.join(browsePath, item);
            const itemStats = fs.statSync(fullPath);
            const relativePath = path.relative(appDir, fullPath);

            return {
                name: item,
                path: relativePath.replace(/\\/g, '/'),
                isDirectory: itemStats.isDirectory(),
                isRoute: !itemStats.isDirectory() && item.endsWith('.json') && item.startsWith('route_')
            };
        }).sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });

        const parentPath = requestedPath ? path.dirname(requestedPath).replace(/\\/g, '/') : null;
        const currentPath = (requestedPath || '').replace(/\\/g, '/');

        sendJson(res, {
            currentPath: currentPath || '.',
            parentPath: parentPath === '.' ? null : parentPath,
            items: items
        });
    } catch (err) {
        sendJson(res, { error: err.message }, 500);
    }
}

/**
 * Load a route file
 */
async function loadRoute(req, res, filename, type, filePath) {
    try {
        let newRoutePath;

        if (filePath) {
            newRoutePath = path.join(appDir, filePath);
            // Security check
            if (!newRoutePath.startsWith(appDir)) {
                sendJson(res, { error: 'Access denied' }, 403);
                return;
            }
        } else if (filename) {
            const routesDir = type === 'processed'
                ? path.join(appDir, 'processed_routes')
                : path.join(appDir, 'unprocessed_routes');
            newRoutePath = path.join(routesDir, filename);
        } else {
            sendJson(res, { error: 'Missing filename or path parameter' }, 400);
            return;
        }

        if (!fs.existsSync(newRoutePath)) {
            sendJson(res, { error: 'Route file not found' }, 404);
            return;
        }

        const result = loadRouteFromFile(newRoutePath);
        sendJson(res, result, result.success ? 200 : 500);
    } catch (err) {
        sendJson(res, { error: err.message }, 500);
    }
}

/**
 * Upload route data from client
 */
async function uploadRoute(req, res) {
    try {
        const body = await parseBody(req);
        const { filename, routeData } = body;

        if (!routeData || !routeData.coordinates || !routeData.routeName) {
            sendJson(res, { error: 'Invalid route data' }, 400);
            return;
        }

        const result = loadRouteFromData(routeData, filename);
        sendJson(res, result, result.success ? 200 : 500);
    } catch (err) {
        console.error('Failed to upload route:', err);
        sendJson(res, { error: err.message }, 500);
    }
}

/**
 * Get current route data
 */
async function getCurrentRoute(req, res) {
    const routeData = getRouteData();
    sendJson(res, routeData);
}

/**
 * Clear the currently loaded route
 */
async function clearCurrentRoute(req, res) {
    clearRoute();
    sendJson(res, { success: true, message: 'Route cleared' });
}

module.exports = {
    listRoutes,
    browseDirectory,
    loadRoute,
    uploadRoute,
    getCurrentRoute,
    clearCurrentRoute
};
