'use strict';
const fs = require('fs');
const path = require('path');

// Path to TSW CommAPI key
const windows_users_folder = process.env.USERPROFILE || 'DefaultUser';
const apiKeyPath = path.join(windows_users_folder, 'Documents', 'My Games', 'TrainSimWorld6', 'Saved', 'Config', 'CommAPIKey.txt');

let cachedApiKey = null;

/**
 * Sleep utility
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read API key from file (synchronous)
 * @returns {string|null} The API key or null if not found
 */
function readApiKey() {
    try {
        const apiKey = fs.readFileSync(apiKeyPath, 'utf8').trim();
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
 * @returns {Promise<string>} The API key
 */
async function waitForValidApiKey() {
    let apiKey = '';
    while (!apiKey) {
        try {
            apiKey = fs.readFileSync(apiKeyPath, 'utf8').trim();
            if (!apiKey) {
                throw new Error('CommAPIKey key is empty');
            }
            console.log('CommAPIKey loaded successfully');
            cachedApiKey = apiKey;
            return apiKey;
        } catch (err) {
            console.log('Waiting for TSW CommAPIKey ...');
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
 * Get the path to the API key file
 * @returns {string}
 */
function getApiKeyPath() {
    return apiKeyPath;
}

module.exports = {
    readApiKey,
    getApiKey,
    waitForValidApiKey,
    hasApiKey,
    getApiKeyPath,
    sleep
};
