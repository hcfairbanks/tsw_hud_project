'use strict';
const fs = require('fs');
const path = require('path');
const { fetchSubscriptionData } = require('./subscriptionController');
const recordingController = require('./recordingController');

// Configuration
const useMiles = false;
const speedConversionFactor = useMiles ? 2.23694 : 3.6;
const distanceConversionFactor = useMiles ? 30.48 : 100;

// State
let loadedRouteData = null;
let routeFilePath = null;
let timetableData = [];
let currentPlayerPosition = null;
let currentHeight = null; // Height from TrackData for recording

// Get the directory where the app is running from
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

/**
 * Load timetable from route data
 */
function loadTimetable() {
    try {
        if (loadedRouteData && loadedRouteData.timetable && Array.isArray(loadedRouteData.timetable) && loadedRouteData.timetable.length > 0) {
            timetableData = loadedRouteData.timetable;
            console.log(`✓ Using embedded timetable: ${timetableData.length} stops`);
            if (timetableData.length > 0) {
                console.log(`  First stop: ${timetableData[0].destination} - Departure: ${timetableData[0].departure} (${timetableData[0].apiName})`);
            }
            return;
        }

        console.warn('⚠ No timetable data found in route file');
        timetableData = [];
    } catch (err) {
        console.error('Failed to load timetable:', err.message);
        timetableData = [];
    }
}

/**
 * Convert time string (HH:MM:SS) to seconds since midnight
 */
function timeToSeconds(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
}

/**
 * Calculate what should be displayed in the timetable box
 */
function getTimetableDisplay(currentTimeISO) {
    if (timetableData.length === 0 || !currentTimeISO) {
        return { time: null, label: null, targetApiName: null, showDistance: false };
    }

    try {
        const timePart = currentTimeISO.split('T')[1].split('.')[0];
        const currentSeconds = timeToSeconds(timePart);

        for (let i = 0; i < timetableData.length; i++) {
            const stop = timetableData[i];
            const departureSeconds = timeToSeconds(stop.departure);
            const arrivalSeconds = timeToSeconds(stop.arrival);

            // First stop - show departure
            if (i === 0) {
                if (currentSeconds < departureSeconds) {
                    return { time: stop.departure, label: 'DEPARTURE', targetApiName: null, showDistance: false };
                }
            }

            // Last stop - only show arrival
            if (i === timetableData.length - 1) {
                return { time: stop.arrival, label: stop.destination, targetApiName: stop.apiName, showDistance: true };
            }

            // Current stop departure time hasn't passed yet
            if (departureSeconds && currentSeconds < departureSeconds) {
                return { time: stop.departure, label: 'DEPARTURE', targetApiName: null, showDistance: false };
            }

            // Check if we're between this departure and next arrival
            if (i < timetableData.length - 1) {
                const nextStop = timetableData[i + 1];
                const nextArrivalSeconds = timeToSeconds(nextStop.arrival);

                if (currentSeconds >= departureSeconds && currentSeconds < nextArrivalSeconds) {
                    return { time: nextStop.arrival, label: nextStop.destination, targetApiName: nextStop.apiName, showDistance: true };
                }

                // At next station, before departure
                if (currentSeconds >= nextArrivalSeconds) {
                    const nextDepartureSeconds = timeToSeconds(nextStop.departure);
                    if (nextDepartureSeconds && currentSeconds < nextDepartureSeconds) {
                        return { time: nextStop.departure, label: 'DEPARTURE', targetApiName: null, showDistance: false };
                    }
                }
            }
        }

        return { time: null, label: null, targetApiName: null, showDistance: false };
    } catch (err) {
        console.error('Error calculating timetable display:', err.message);
        return { time: null, label: null, targetApiName: null, showDistance: false };
    }
}

/**
 * Calculate distance between two lat/lng points using Haversine formula
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Find nearest coordinate index on route to given position
 */
function findNearestRouteIndex(lat, lon) {
    if (!loadedRouteData || !loadedRouteData.coordinates) {
        return -1;
    }

    let minDistance = Infinity;
    let nearestIndex = 0;

    for (let i = 0; i < loadedRouteData.coordinates.length; i++) {
        const coord = loadedRouteData.coordinates[i];
        const distance = calculateDistance(lat, lon, coord.latitude, coord.longitude);

        if (distance < minDistance) {
            minDistance = distance;
            nearestIndex = i;
        }
    }

    return nearestIndex;
}

/**
 * Calculate distance along route from player to marker
 */
function calculateDistanceAlongRoute(playerLat, playerLon, markerLat, markerLon) {
    if (!loadedRouteData || !loadedRouteData.coordinates) {
        return null;
    }

    const playerIndex = findNearestRouteIndex(playerLat, playerLon);
    const markerIndex = findNearestRouteIndex(markerLat, markerLon);

    if (playerIndex === -1 || markerIndex === -1) {
        return null;
    }

    if (markerIndex <= playerIndex) {
        return 0;
    }

    let totalDistance = 0;
    for (let i = playerIndex; i < markerIndex; i++) {
        const coord1 = loadedRouteData.coordinates[i];
        const coord2 = loadedRouteData.coordinates[i + 1];
        totalDistance += calculateDistance(
            coord1.latitude,
            coord1.longitude,
            coord2.latitude,
            coord2.longitude
        );
    }

    return totalDistance;
}

/**
 * Get next timetable station based on current target
 * Now uses timetable entries (which have coordinates) instead of markers
 */
function getNextTimetableStation(targetApiName) {
    if (!targetApiName || !timetableData || timetableData.length === 0) {
        return null;
    }

    // Find the timetable entry that matches the target
    const station = timetableData.find(entry =>
        entry.apiName === targetApiName || entry.destination === targetApiName
    );

    if (!station || !station.latitude || !station.longitude) {
        return null;
    }

    return {
        name: station.destination,
        latitude: station.latitude,
        longitude: station.longitude,
        arrival: station.arrival,
        departure: station.departure,
        platform: station.platform,
        index: station.index
    };
}

/**
 * Parse raw TSW subscription data into stream format
 */
function parseSubscriptionData(rawData) {
    const streamData = {
        playerPosition: null,
        localTime: null,
        timetableTime: null,
        timetableLabel: null,
        distanceToStation: null,
        nextStation: null,  // Next timetable station info
        speed: 0,
        direction: 0,
        limit: 0,
        isSlipping: false,
        powerHandle: 0,
        incline: 0,
        nextSpeedLimit: 0,
        distanceToNextSpeedLimit: 0,
        trainBreak: 0,
        trainBrakeActive: false,
        locomotiveBrakeHandle: 0,
        locomotiveBrakeActive: false,
        electricDynamicBrake: 0,
        electricBrakeActive: false,
        isTractionLocked: false,
        // Weather data
        weather: {
            Temperature: null,
            Cloudiness: null,
            Precipitation: null,
            Wetness: null,
            GroundSnow: null,
            PiledSnow: null,
            FogDensity: null
        }
    };

    if (rawData.Entries && rawData.Entries.length > 0) {
        for (const entry of rawData.Entries) {
            if (entry.NodeValid && entry.Values) {
                // Extract GPS coordinates
                if (entry.Path === 'DriverAid.PlayerInfo') {
                    if (entry.Values.geoLocation &&
                        typeof entry.Values.geoLocation.longitude === 'number' &&
                        typeof entry.Values.geoLocation.latitude === 'number') {

                        currentPlayerPosition = {
                            longitude: entry.Values.geoLocation.longitude,
                            latitude: entry.Values.geoLocation.latitude
                        };
                        streamData.playerPosition = currentPlayerPosition;
                        // Store geoLocation for recording after all entries are processed
                        streamData._geoLocation = entry.Values.geoLocation;
                    }
                }
                // Extract track data for markers and height
                else if (entry.Path === 'DriverAid.TrackData') {
                    // Extract height from lastPlayerPosition and store for recording
                    if (entry.Values.lastPlayerPosition && typeof entry.Values.lastPlayerPosition.height === 'number') {
                        currentHeight = entry.Values.lastPlayerPosition.height;
                    }

                    // Store stations and markers for recording after all entries are processed
                    if (entry.Values.stations && Array.isArray(entry.Values.stations)) {
                        streamData._stations = entry.Values.stations;
                    }
                    if (entry.Values.markers && Array.isArray(entry.Values.markers)) {
                        streamData._markers = entry.Values.markers;
                    }
                }
                // Extract speed
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetSpeed' && entry.Values['Speed (ms)']) {
                    streamData.speed = Math.round(entry.Values['Speed (ms)'] * speedConversionFactor);
                }
                // Extract direction
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetDirection' && entry.Values['Direction'] !== undefined) {
                    streamData.direction = entry.Values['Direction'];
                }
                // Extract power handle
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetPowerHandle' && entry.Values['Power'] !== undefined) {
                    const powerValue = entry.Values['Power'];
                    const isNegative = entry.Values['IsNegative'];
                    const roundedValue = powerValue >= 0 ? Math.ceil(powerValue) : Math.floor(powerValue);
                    streamData.powerHandle = (isNegative === true) ? -Math.abs(roundedValue) : roundedValue;
                }
                // Extract is slipping
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetIsSlipping' && entry.Values['IsSlipping'] !== undefined) {
                    streamData.isSlipping = entry.Values['IsSlipping'];
                }
                // Extract train brake
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetTrainBrakeHandle' && entry.Values['HandlePosition'] !== undefined) {
                    streamData.trainBreak = Math.round(entry.Values['HandlePosition'] * 100);
                    streamData.trainBrakeActive = entry.Values['IsActive'] || false;
                }
                // Extract locomotive brake
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetLocomotiveBrakeHandle' && entry.Values['HandlePosition'] !== undefined) {
                    streamData.locomotiveBrakeHandle = entry.Values['HandlePosition'];
                    streamData.locomotiveBrakeActive = entry.Values['IsActive'] || false;
                }
                // Extract electric brake
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetElectricBrakeHandle' && entry.Values['HandlePosition'] !== undefined) {
                    streamData.electricDynamicBrake = Math.round(entry.Values['HandlePosition'] * 100);
                    streamData.electricBrakeActive = entry.Values['IsActive'] || false;
                }
                // Extract traction locked
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetIsTractionLocked' && entry.Values['IsTractionLocked'] !== undefined) {
                    streamData.isTractionLocked = entry.Values['IsTractionLocked'];
                }
                // Extract max permitted speed
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetMaxPermittedSpeed' && entry.Values['MaxPermittedSpeed'] !== undefined) {
                    streamData.maxPermittedSpeed = Math.round(entry.Values['MaxPermittedSpeed'] * speedConversionFactor);
                }
                // Extract speed limit and gradient from DriverAid.Data
                else if (entry.Path === 'DriverAid.Data') {
                    if (entry.Values['speedLimit'] && entry.Values['speedLimit']['value']) {
                        streamData.limit = Math.round(entry.Values['speedLimit']['value'] * speedConversionFactor);
                    }
                    if (entry.Values['gradient'] !== undefined) {
                        streamData.incline = parseFloat(entry.Values['gradient'].toFixed(1)); // Rounded for display
                        streamData._rawGradient = entry.Values['gradient']; // Raw value for recording
                    }
                    if (entry.Values['nextSpeedLimit'] && entry.Values['nextSpeedLimit']['value']) {
                        streamData.nextSpeedLimit = Math.round(entry.Values['nextSpeedLimit']['value'] * speedConversionFactor);
                    }
                    if (entry.Values['distanceToNextSpeedLimit'] !== undefined) {
                        streamData.distanceToNextSpeedLimit = Math.round(entry.Values['distanceToNextSpeedLimit'] / distanceConversionFactor);
                    }
                }
                // Extract local time
                else if (entry.Path === 'TimeOfDay.Data') {
                    if (entry.Values['LocalTimeISO8601']) {
                        streamData.localTime = entry.Values['LocalTimeISO8601'];
                    }
                }
                // Extract weather data (API returns capitalized property names)
                else if (entry.Path === 'WeatherManager.Data') {
                    if (entry.Values.Temperature !== undefined) {
                        streamData.weather.Temperature = entry.Values.Temperature;
                    }
                    if (entry.Values.Cloudiness !== undefined) {
                        streamData.weather.Cloudiness = entry.Values.Cloudiness;
                    }
                    if (entry.Values.Precipitation !== undefined) {
                        streamData.weather.Precipitation = entry.Values.Precipitation;
                    }
                    if (entry.Values.Wetness !== undefined) {
                        streamData.weather.Wetness = entry.Values.Wetness;
                    }
                    if (entry.Values.GroundSnow !== undefined) {
                        streamData.weather.GroundSnow = entry.Values.GroundSnow;
                    }
                    if (entry.Values.PiledSnow !== undefined) {
                        streamData.weather.PiledSnow = entry.Values.PiledSnow;
                    }
                    if (entry.Values.FogDensity !== undefined) {
                        streamData.weather.FogDensity = entry.Values.FogDensity;
                    }
                }
            }
        }
    }

    // Process recording data after all entries are parsed (so streamData.incline is available)
    if (recordingController.isRecordingActive()) {
        // Record coordinate with raw gradient from stream (not rounded)
        if (streamData._geoLocation) {
            recordingController.processCoordinate(
                streamData._geoLocation,
                streamData._rawGradient, // Raw value, not rounded
                currentHeight
            );
        }
        // Record stations
        if (streamData._stations) {
            for (const station of streamData._stations) {
                recordingController.processMarker(station, station.distanceToStationCM || 0);
            }
        }
        // Record markers
        if (streamData._markers) {
            for (const marker of streamData._markers) {
                recordingController.processMarker(marker, marker.distanceToStationCM || 0);
            }
        }
    }

    // Clean up temporary properties
    delete streamData._geoLocation;
    delete streamData._stations;
    delete streamData._markers;
    delete streamData._rawGradient;

    // Include recording state in stream if recording is active
    const recordingState = recordingController.getRecordingStateForStream();
    if (recordingState) {
        streamData.recording = recordingState;
    }

    // Calculate timetable display and distance
    if (streamData.localTime) {
        const timetableDisplay = getTimetableDisplay(streamData.localTime);
        streamData.timetableTime = timetableDisplay.time;
        streamData.timetableLabel = timetableDisplay.label;

        // Calculate distance along route to next station
        if (timetableDisplay.targetApiName && currentPlayerPosition) {
            const nextStation = getNextTimetableStation(timetableDisplay.targetApiName);

            if (nextStation && nextStation.latitude && nextStation.longitude) {
                const distance = calculateDistanceAlongRoute(
                    currentPlayerPosition.latitude,
                    currentPlayerPosition.longitude,
                    nextStation.latitude,
                    nextStation.longitude
                );

                if (distance !== null) {
                    streamData.distanceToStation = Math.round(distance);
                }

                // Also include the next station info in stream
                streamData.nextStation = {
                    name: nextStation.name,
                    arrival: nextStation.arrival,
                    platform: nextStation.platform,
                    index: nextStation.index
                };
            }
        }
    }

    return streamData;
}

/**
 * Fetch and parse current telemetry data
 */
async function getTelemetryData() {
    const rawData = await fetchSubscriptionData();
    return parseSubscriptionData(rawData);
}

/**
 * Load route data from file
 */
function loadRouteFromFile(filePath) {
    try {
        const routeData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        loadedRouteData = routeData;
        routeFilePath = filePath;

        if (routeData.timetable) {
            timetableData = routeData.timetable;
            console.log(`Loaded route: ${path.basename(filePath)}`);
            console.log(`  ${timetableData.length} stops from timetable`);
        } else {
            timetableData = [];
            console.log(`Loaded route: ${path.basename(filePath)} (no timetable)`);
        }

        return {
            success: true,
            message: `Loaded ${path.basename(filePath)}`,
            routeName: routeData.routeName,
            totalPoints: routeData.totalPoints,
            totalMarkers: routeData.totalMarkers
        };
    } catch (err) {
        return {
            success: false,
            error: err.message
        };
    }
}

/**
 * Load route data from object
 */
function loadRouteFromData(routeData, filename) {
    loadedRouteData = routeData;
    routeFilePath = filename;

    if (routeData.timetable) {
        timetableData = routeData.timetable;
        console.log(`✓ User loaded route: ${filename}`);
        console.log(`  Route: ${routeData.routeName}`);
        console.log(`  Coordinates: ${routeData.totalPoints}`);
        console.log(`  Markers: ${routeData.totalMarkers}`);
        console.log(`  Timetable: ${timetableData.length} stops`);
    } else {
        timetableData = [];
        console.log(`✓ User loaded route: ${filename} (no timetable)`);
    }

    return {
        success: true,
        message: `Loaded ${filename}`,
        routeName: routeData.routeName,
        totalPoints: routeData.totalPoints,
        totalMarkers: routeData.totalMarkers
    };
}

/**
 * Get loaded route data
 */
function getRouteData() {
    if (!loadedRouteData) {
        return { error: 'No route loaded. Please select a route file.' };
    }

    return {
        ...loadedRouteData,
        timetableStations: timetableData.map(stop => stop.station),
        currentRouteFile: routeFilePath ? path.basename(routeFilePath) : 'unknown'
    };
}

/**
 * Check if a route is loaded
 */
function hasRouteLoaded() {
    return loadedRouteData !== null;
}

/**
 * Clear loaded route data
 */
function clearRoute() {
    loadedRouteData = null;
    routeFilePath = null;
    timetableData = [];
    currentTimetableIndex = 0;
    console.log('Route data cleared');
}

/**
 * Get current player position
 */
function getPlayerPosition() {
    return currentPlayerPosition;
}

module.exports = {
    getTelemetryData,
    parseSubscriptionData,
    loadRouteFromFile,
    loadRouteFromData,
    getRouteData,
    hasRouteLoaded,
    clearRoute,
    getPlayerPosition,
    loadTimetable,
    calculateDistance,
    calculateDistanceAlongRoute
};
