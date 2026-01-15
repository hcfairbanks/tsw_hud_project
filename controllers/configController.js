'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson, parseBody } = require('../utils/http');

// Get the directory where the app is running from
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const configPath = path.join(appDir, 'configuration.json');

// Default configuration
const defaultConfig = {
    developmentMode: false
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

        // Merge with current config
        const newConfig = { ...currentConfig, ...body };

        if (saveConfig(newConfig)) {
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
