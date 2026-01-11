'use strict';
const { sendJson } = require('../utils/http');
const { tswApiRequest } = require('./subscriptionController');
const { getApiKey } = require('../utils/apiKey');

// Weather value names for the UI
const WEATHER_VALUES = [
    { key: 'Reset', label: 'Reset All', description: 'Reset weather to default' },
    { key: 'Temperature', label: 'Temperature', description: 'Current temperature', unit: '°C' },
    { key: 'Cloudiness', label: 'Cloudiness', description: 'Cloud cover level', unit: '%', min: 0, max: 1 },
    { key: 'Precipitation', label: 'Precipitation', description: 'Rain/Snow intensity', unit: '%', min: 0, max: 1 },
    { key: 'Wetness', label: 'Wetness', description: 'Surface wetness level', unit: '%', min: 0, max: 1 },
    { key: 'GroundSnow', label: 'Ground Snow', description: 'Snow accumulation on ground', unit: '%', min: 0, max: 1 },
    { key: 'PiledSnow', label: 'Piled Snow', description: 'Piled snow amount', unit: '%', min: 0, max: 1 },
    { key: 'FogDensity', label: 'Fog Density', description: 'Fog thickness', unit: '%', min: 0, max: 1 }
];

// Track if weather subscription is created
let weatherSubscriptionCreated = false;

/**
 * Create weather subscription
 */
async function createWeatherSubscription() {
    if (weatherSubscriptionCreated) {
        return true;
    }

    try {
        await tswApiRequest('POST', '/subscription/WeatherManager.Data?Subscription=1');
        weatherSubscriptionCreated = true;
        console.log('Weather subscription created');
        return true;
    } catch (err) {
        console.error('Failed to create weather subscription:', err.message);
        return false;
    }
}

/**
 * Fetch current weather data
 */
async function fetchWeatherData() {
    try {
        // Ensure subscription exists
        await createWeatherSubscription();

        const data = await tswApiRequest('GET', '/subscription/?Subscription=1');

        // Parse weather data from subscription response
        const weatherData = {
            Temperature: null,
            Cloudiness: null,
            Precipitation: null,
            Wetness: null,
            GroundSnow: null,
            PiledSnow: null,
            FogDensity: null
        };

        if (data.Entries && data.Entries.length > 0) {
            for (const entry of data.Entries) {
                if (entry.Path === 'WeatherManager.Data' && entry.NodeValid && entry.Values) {
                    // Map the values from the API response
                    if (entry.Values.temperature !== undefined) {
                        weatherData.Temperature = entry.Values.temperature;
                    }
                    if (entry.Values.cloudiness !== undefined) {
                        weatherData.Cloudiness = entry.Values.cloudiness;
                    }
                    if (entry.Values.precipitation !== undefined) {
                        weatherData.Precipitation = entry.Values.precipitation;
                    }
                    if (entry.Values.wetness !== undefined) {
                        weatherData.Wetness = entry.Values.wetness;
                    }
                    if (entry.Values.groundSnow !== undefined) {
                        weatherData.GroundSnow = entry.Values.groundSnow;
                    }
                    if (entry.Values.piledSnow !== undefined) {
                        weatherData.PiledSnow = entry.Values.piledSnow;
                    }
                    if (entry.Values.fogDensity !== undefined) {
                        weatherData.FogDensity = entry.Values.fogDensity;
                    }
                }
            }
        }

        return weatherData;
    } catch (err) {
        console.error('Failed to fetch weather data:', err.message);
        return null;
    }
}

/**
 * Set a weather value
 * @param {string} key - Weather parameter key (e.g., 'Precipitation')
 * @param {number} value - Value to set (0-1 for most, varies for temperature)
 */
async function setWeatherValue(key, value) {
    try {
        // Validate key
        const validKey = WEATHER_VALUES.find(w => w.key === key);
        if (!validKey) {
            return { success: false, error: `Invalid weather key: ${key}` };
        }

        // Send PATCH request to set the value
        const path = `/set/WeatherManager.${key}?value=${value}`;
        await tswApiRequest('PATCH', path);

        console.log(`Weather ${key} set to ${value}`);
        return { success: true, key, value };
    } catch (err) {
        console.error(`Failed to set weather ${key}:`, err.message);
        return { success: false, error: err.message };
    }
}

/**
 * API handler: Get weather data
 */
async function getWeather(req, res) {
    const apiKey = getApiKey();
    if (!apiKey) {
        sendJson(res, { error: 'TSW API key not available. Is Train Sim World running?' }, 503);
        return;
    }

    const weatherData = await fetchWeatherData();
    if (weatherData === null) {
        sendJson(res, { error: 'Failed to fetch weather data' }, 500);
        return;
    }

    sendJson(res, {
        weather: weatherData,
        parameters: WEATHER_VALUES
    });
}

/**
 * API handler: Set weather value
 */
async function setWeather(req, res, key, value) {
    const apiKey = getApiKey();
    if (!apiKey) {
        sendJson(res, { error: 'TSW API key not available. Is Train Sim World running?' }, 503);
        return;
    }

    const result = await setWeatherValue(key, value);
    sendJson(res, result, result.success ? 200 : 400);
}

/**
 * Get available weather parameters
 */
async function getWeatherParams(req, res) {
    sendJson(res, { parameters: WEATHER_VALUES });
}

module.exports = {
    getWeather,
    setWeather,
    getWeatherParams,
    fetchWeatherData,
    setWeatherValue,
    createWeatherSubscription,
    WEATHER_VALUES
};
