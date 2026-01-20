'use strict';
const fs = require('fs');
const path = require('path');

// Default paths to TSW CommAPI key files
const windows_users_folder = process.env.USERPROFILE || 'DefaultUser';
const defaultTsw5Path = path.join(windows_users_folder, 'Documents', 'My Games', 'TrainSimWorld5', 'Saved', 'Config', 'CommAPIKey.txt');
const defaultTsw6Path = path.join(windows_users_folder, 'Documents', 'My Games', 'TrainSimWorld6', 'Saved', 'Config', 'CommAPIKey.txt');

// Path to app configuration
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const configPath = path.join(appDir, 'configuration.json');

let cachedApiKey = null;

/**
 * Load configuration from file
 * @returns {object} The config object or empty object
 */
function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        // Config file doesn't exist or is invalid
    }
    return {};
}

/**
 * Get the API key path based on selected TSW version
 * @returns {string} The path to the CommAPIKey.txt file
 */
function getSelectedApiKeyPath() {
    const config = loadConfig();
    const tswVersion = config.tswVersion || 'tsw6';

    if (tswVersion === 'tsw5') {
        // Use custom path if set, otherwise use default TSW5 path
        return (config.tsw5KeyPath && config.tsw5KeyPath.trim()) || defaultTsw5Path;
    } else {
        // Use custom path if set, otherwise use default TSW6 path
        return (config.tsw6KeyPath && config.tsw6KeyPath.trim()) || defaultTsw6Path;
    }
}

/**
 * Load API key from configuration file (direct key entry)
 * @returns {string|null} The API key from config or null
 */
function loadApiKeyFromConfig() {
    const config = loadConfig();
    if (config.apiKey && config.apiKey.trim()) {
        return config.apiKey.trim();
    }
    return null;
}

/**
 * Sleep utility
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read API key from file (synchronous)
 * First checks configuration for direct key, then reads from selected TSW version path
 * @returns {string|null} The API key or null if not found
 */
function readApiKey() {
    // First, check configuration file for direct API key entry
    const configKey = loadApiKeyFromConfig();
    if (configKey) {
        cachedApiKey = configKey;
        return configKey;
    }

    // Read from selected TSW version's CommAPIKey.txt path
    const keyPath = getSelectedApiKeyPath();
    try {
        const apiKey = fs.readFileSync(keyPath, 'utf8').trim();
        if (apiKey) {
            cachedApiKey = apiKey;
            return apiKey;
        }
        return null;
    } catch (err) {
        return null;
    }
}

/**
 * Get cached API key or read from file
 * @returns {string|null} The API key or null
 */
function getApiKey() {
    if (cachedApiKey) {
        return cachedApiKey;
    }
    return readApiKey();
}

/**
 * Wait for valid API key, retrying until found
 * First checks configuration for direct key, then reads from selected TSW version path
 * @returns {Promise<string>} The API key
 */
async function waitForValidApiKey() {
    let apiKey = '';
    while (!apiKey) {
        // First, check configuration file for direct API key entry
        const configKey = loadApiKeyFromConfig();
        if (configKey) {
            console.log('API key loaded from configuration');
            cachedApiKey = configKey;
            return configKey;
        }

        // Read from selected TSW version's CommAPIKey.txt path
        const keyPath = getSelectedApiKeyPath();
        const config = loadConfig();
        const tswVersion = config.tswVersion || 'tsw6';

        try {
            apiKey = fs.readFileSync(keyPath, 'utf8').trim();
            if (!apiKey) {
                throw new Error('CommAPIKey key is empty');
            }
            console.log(`CommAPIKey loaded successfully from ${tswVersion.toUpperCase()} path: ${keyPath}`);
            cachedApiKey = apiKey;
            return apiKey;
        } catch (err) {
            console.log(`Waiting for ${tswVersion.toUpperCase()} CommAPIKey at: ${keyPath}`);
            await sleep(3000);
        }
    }
    return apiKey;
}

/**
 * Check if API key is available
 * @returns {boolean}
 */
function hasApiKey() {
    return !!getApiKey();
}

/**
 * Get the path to the API key file based on selected TSW version
 * @returns {string}
 */
function getApiKeyPath() {
    return getSelectedApiKeyPath();
}

/**
 * Get default paths for TSW5 and TSW6
 * @returns {object} Object with tsw5 and tsw6 default paths
 */
function getDefaultPaths() {
    return {
        tsw5: defaultTsw5Path,
        tsw6: defaultTsw6Path
    };
}

/**
 * Clear the cached API key (used when settings are updated)
 */
function clearApiKeyCache() {
    cachedApiKey = null;
}

module.exports = {
    readApiKey,
    getApiKey,
    waitForValidApiKey,
    hasApiKey,
    getApiKeyPath,
    getDefaultPaths,
    clearApiKeyCache,
    sleep
};
