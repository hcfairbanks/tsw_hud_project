'use strict';
const http = require('http');
const { getApiKey, sleep } = require('../utils/apiKey');

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
    return await tswApiRequest('GET', '/subscription/?Subscription=1');
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

module.exports = {
    deleteSubscription,
    createSubscriptions,
    initializeSubscriptions,
    fetchSubscriptionData,
    resetSubscriptionState,
    areSubscriptionsCreated,
    tswApiRequest
};
