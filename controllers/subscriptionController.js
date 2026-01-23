'use strict';
const http = require('http');
const { getApiKey, hasApiKey, sleep } = require('../utils/apiKey');
const { sendJson } = require('../utils/http');
const fs = require('fs');
const path = require('path');

// Path to app configuration (to check apiKey source)
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const configPath = path.join(appDir, 'configuration.json');

const TSW_API_HOST = 'localhost';
const TSW_API_PORT = 31270;

// Subscription endpoints
const subscriptionEndpoints = [
    '/subscription/TimeOfDay.Data?Subscription=1',
    '/subscription/DriverAid.Data?Subscription=1',
    '/subscription/DriverAid.PlayerInfo?Subscription=1',
    '/subscription/DriverAid.TrackData?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetSpeed?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetDirection?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetPowerHandle?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetIsSlipping?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetBrakeGauge_1?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetBrakeGauge_2?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetAcceleration?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetSpeedControlTarget?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetMaxPermittedSpeed?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetTractiveEffort?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetElectricBrakeHandle?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetLocomotiveBrakeHandle?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetTrainBrakeHandle?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetIsTractionLocked?Subscription=1',
    '/subscription/CurrentFormation/1/Door_PassengerDoor_BR.Function.GetCurrentOutputValue?Subscription=1',
    '/subscription/CurrentFormation/1/Door_PassengerDoor_BL.Function.GetCurrentOutputValue?Subscription=1',
    '/subscription/CurrentDrivableActor/PassengerDoor_FR.Function.GetCurrentInputValue?Subscription=1',
    '/subscription/CurrentDrivableActor/PassengerDoor_FL.Function.GetCurrentInputValue?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetDirection?Subscription=1',
    '/subscription/WeatherManager.Data?Subscription=1'
];

// Track subscription state
let subscriptionsCreated = false;

/**
 * Make HTTP request to TSW API
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @returns {Promise<object>}
 */
function tswApiRequest(method, path) {
    return new Promise((resolve, reject) => {
        const apiKey = getApiKey();
        if (!apiKey) {
            reject(new Error('No API key available'));
            return;
        }

        const options = {
            hostname: TSW_API_HOST,
            port: TSW_API_PORT,
            path: path,
            method: method,
            headers: {
                'DTGCommKey': apiKey
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (data) {
                        resolve(JSON.parse(data));
                    } else {
                        resolve({});
                    }
                } catch (e) {
                    resolve({ raw: data });
                }
            });
        });

        req.on('error', (err) => {
            // Log connection errors with rate limiting
            if (!tswApiRequest.lastErrorLog || Date.now() - tswApiRequest.lastErrorLog > 5000) {
                tswApiRequest.lastErrorLog = Date.now();
                console.error(`[TSW API] Connection error: ${err.message} - Is TSW running with CommAPI enabled?`);
            }
            reject(err);
        });

        req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
}

/**
 * Delete existing subscriptions
 */
async function deleteSubscription() {
    console.log('Deleting old subscription...');
    try {
        await tswApiRequest('DELETE', '/subscription?Subscription=1');
        console.log('Old subscription deleted successfully');
    } catch (err) {
        console.error('Failed to delete old subscription:', err.message);
    }
}

/**
 * Create all required subscriptions
 */
async function createSubscriptions() {
    if (subscriptionsCreated) {
        console.log('Subscriptions already created, skipping...');
        return;
    }

    console.log('Creating subscriptions...');
    for (const endpoint of subscriptionEndpoints) {
        try {
            await tswApiRequest('POST', endpoint);
            console.log(`Subscription created for ${endpoint}`);
        } catch (err) {
            console.error(`Failed to create subscription ${endpoint}:`, err.message);
        }

        // Wait 250ms between each subscription request
        await sleep(250);
    }
    subscriptionsCreated = true;
    console.log('All subscriptions created');
}

/**
 * Initialize subscriptions (delete old and create new)
 */
async function initializeSubscriptions() {
    await deleteSubscription();
    await sleep(500);
    await createSubscriptions();
}

/**
 * Fetch subscription data from TSW API
 * @returns {Promise<object>}
 */
async function fetchSubscriptionData() {
    const data = await tswApiRequest('GET', '/subscription/?Subscription=1');
    // Debug logging - log once every 5 seconds to avoid spam
    if (!fetchSubscriptionData.lastLog || Date.now() - fetchSubscriptionData.lastLog > 5000) {
        fetchSubscriptionData.lastLog = Date.now();
        if (data && data.Entries) {
            console.log(`[Subscription] Received ${data.Entries.length} entries from TSW API`);
        } else if (data && Object.keys(data).length === 0) {
            console.log('[Subscription] TSW API returned empty object - check if game is running and subscriptions are active');
        } else if (data && data.raw) {
            console.log('[Subscription] TSW API returned non-JSON response:', data.raw.substring(0, 100));
        } else {
            console.log('[Subscription] TSW API returned:', JSON.stringify(data).substring(0, 200));
        }
    }
    return data;
}

/**
 * Reset subscription state (allows recreating subscriptions)
 */
function resetSubscriptionState() {
    subscriptionsCreated = false;
}

/**
 * Check if subscriptions have been created
 * @returns {boolean}
 */
function areSubscriptionsCreated() {
    return subscriptionsCreated;
}

/**
 * Get API key source (configuration or TSW file)
 * @returns {string}
 */
function getApiKeySource() {
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(data);
            if (config.apiKey && config.apiKey.trim()) {
                return 'Configuration File';
            }
        }
    } catch (err) {
        // Ignore
    }
    return 'TSW CommAPIKey.txt';
}

/**
 * GET /api/subscription/status - Get subscription status
 */
function getStatus(req, res) {
    sendJson(res, {
        hasApiKey: hasApiKey(),
        apiKeySource: hasApiKey() ? getApiKeySource() : null,
        subscriptionsCreated: areSubscriptionsCreated()
    });
}

/**
 * POST /api/subscription/reset - Reset subscriptions (delete and recreate)
 */
async function resetSubscriptionsHandler(req, res) {
    try {
        resetSubscriptionState();
        await deleteSubscription();
        await sleep(500);
        await createSubscriptions();
        sendJson(res, { success: true });
    } catch (err) {
        sendJson(res, { success: false, error: err.message }, 500);
    }
}

/**
 * POST /api/subscription/delete - Delete subscriptions only
 */
async function deleteSubscriptionsHandler(req, res) {
    try {
        resetSubscriptionState();
        await deleteSubscription();
        sendJson(res, { success: true });
    } catch (err) {
        sendJson(res, { success: false, error: err.message }, 500);
    }
}

/**
 * POST /api/subscription/create - Create subscriptions only
 */
async function createSubscriptionsHandler(req, res) {
    try {
        resetSubscriptionState();
        await createSubscriptions();
        sendJson(res, { success: true });
    } catch (err) {
        sendJson(res, { success: false, error: err.message }, 500);
    }
}

/**
 * GET /api/subscription/data - Get live subscription data
 */
async function getSubscriptionData(req, res) {
    try {
        const data = await fetchSubscriptionData();
        sendJson(res, data);
    } catch (err) {
        sendJson(res, { error: err.message }, 500);
    }
}

module.exports = {
    deleteSubscription,
    createSubscriptions,
    initializeSubscriptions,
    fetchSubscriptionData,
    resetSubscriptionState,
    areSubscriptionsCreated,
    tswApiRequest,
    getStatus,
    resetSubscriptionsHandler,
    deleteSubscriptionsHandler,
    createSubscriptionsHandler,
    getSubscriptionData
};
