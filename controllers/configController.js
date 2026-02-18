'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson, parseBody } = require('../utils/http');
const { clearApiKeyCache } = require('../utils/apiKey');

// Get the directory where the app is running from
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const configPath = path.join(appDir, 'configuration.json');

// Default configuration
const defaultConfig = {
    developmentMode: false,
    apiKey: '',
    theme: 'dark', // 'dark' or 'light'
    language: 'en', // Language code: en, en-US, fr, de, it, es, pl, ru, zh, ja
    tswVersion: 'tsw6', // 'tsw5' or 'tsw6'
    tsw5KeyPath: '', // Path to TSW5 CommAPIKey.txt
    tsw6KeyPath: '',  // Path to TSW6 CommAPIKey.txt
    distanceUnits: 'metric', // 'metric' (km/m) or 'imperial' (miles/feet)
    temperatureUnits: 'celsius', // 'celsius' or 'fahrenheit'
    contributorName: '', // Name to use as contributor when creating timetables
    // Recording settings
    simplifyEpsilon: 1, // meters - path simplification tolerance
    minStopDurationSeconds: 30, // seconds - minimum stop duration for auto-detection
    gpsNoiseRadiusMeters: 10, // meters - max distance for "same location" in stop detection
    minPointsForStop: 10, // minimum coordinate points to form a valid stop
    autoStopTimeoutSeconds: 120, // seconds - inactivity timeout before auto-stop
    saveFrequency: 1 // save recording data every N coordinates
};

/**
 * Load configuration from file
 */
function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            return { ...defaultConfig, ...JSON.parse(data) };
        }
    } catch (err) {
        console.error('Error loading configuration:', err);
    }
    return { ...defaultConfig };
}

/**
 * Save configuration to file
 */
function saveConfig(config) {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        return true;
    } catch (err) {
        console.error('Error saving configuration:', err);
        return false;
    }
}

/**
 * GET /api/config - Get current configuration
 */
function getConfig(req, res) {
    const config = loadConfig();
    sendJson(res, config);
}

/**
 * PUT /api/config - Update configuration
 */
async function updateConfig(req, res) {
    try {
        const body = await parseBody(req);
        const currentConfig = loadConfig();

        // Check if any API key related setting is being updated
        const apiKeyChanged = body.apiKey !== undefined && body.apiKey !== currentConfig.apiKey;
        const tswVersionChanged = body.tswVersion !== undefined && body.tswVersion !== currentConfig.tswVersion;
        const tsw5PathChanged = body.tsw5KeyPath !== undefined && body.tsw5KeyPath !== currentConfig.tsw5KeyPath;
        const tsw6PathChanged = body.tsw6KeyPath !== undefined && body.tsw6KeyPath !== currentConfig.tsw6KeyPath;

        // Merge with current config
        const newConfig = { ...currentConfig, ...body };

        if (saveConfig(newConfig)) {
            // Clear API key cache if any API-related setting was updated
            if (apiKeyChanged || tswVersionChanged || tsw5PathChanged || tsw6PathChanged) {
                clearApiKeyCache();
            }
            sendJson(res, { success: true, config: newConfig });
        } else {
            sendJson(res, { success: false, error: 'Failed to save configuration' }, 500);
        }
    } catch (err) {
        sendJson(res, { success: false, error: err.message }, 500);
    }
}

module.exports = {
    getConfig,
    updateConfig,
    loadConfig
};
