'use strict';
const fs = require('fs');
const path = require('path');
const { fetchSubscriptionData } = require('./subscriptionController');
const recordingController = require('./recordingController');
const { loadConfig } = require('./configController');

// Get distance units from config
function getDistanceUnits() {
    const config = loadConfig();
    return config.distanceUnits || 'metric';
}

// Get temperature units from config
function getTemperatureUnits() {
    const config = loadConfig();
    return config.temperatureUnits || 'celsius';
}

// Get conversion factors based on units setting
function getConversionFactors() {
    const units = getDistanceUnits();
    const useMiles = units === 'imperial';
    return {
        speedConversionFactor: useMiles ? 2.23694 : 3.6,  // m/s to mph or km/h
        distanceConversionFactor: useMiles ? 30.48 : 100, // cm to feet or meters
        units: units
    };
}

// State
let loadedRouteData = null;
let routeFilePath = null;
let timetableData = [];
let currentPlayerPosition = null;
let currentHeight = null; // Height from TrackData for recording
let lastArrivedStationIndex = -1; // Track which station the player has physically arrived at (-1 = not started yet)
let closestDistanceToNextStation = Infinity; // Track closest distance to detect when player has PASSED a station

// Distance threshold in meters to consider player "arrived" at a station
const ARRIVAL_THRESHOLD_METERS = 100;

// Get the directory where the app is running from
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

/**
 * Load timetable from route data
 */
function loadTimetable() {
    try {
        // Reset station arrival tracking when loading new timetable
        lastArrivedStationIndex = -1;
        closestDistanceToNextStation = Infinity;

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
 * Check if player has arrived at a station (within threshold distance)
 */
function checkStationArrival(playerLat, playerLon, stationLat, stationLon) {
    if (!playerLat || !playerLon || !stationLat || !stationLon) {
        return false;
    }
    const distance = calculateDistance(playerLat, playerLon, stationLat, stationLon);
    return distance <= ARRIVAL_THRESHOLD_METERS;
}

/**
 * Calculate what should be displayed in the timetable box
 * TESTING MODE: Only advances to next station after player has PASSED the station
 * (distance starts increasing after getting close)
 */
function getTimetableDisplay(currentTimeISO) {
    if (timetableData.length === 0 || !currentTimeISO) {
        return { time: null, label: null, targetApiName: null, showDistance: false };
    }

    try {
        const timePart = currentTimeISO.split('T')[1].split('.')[0];
        const currentSeconds = timeToSeconds(timePart);

        // Check if player has ARRIVED at the current target station (within threshold distance)
        if (currentPlayerPosition && lastArrivedStationIndex >= 0 && lastArrivedStationIndex < timetableData.length - 1) {
            const nextStationIndex = lastArrivedStationIndex + 1;
            const nextStation = timetableData[nextStationIndex];

            if (nextStation && nextStation.latitude && nextStation.longitude) {
                const currentDistance = calculateDistance(
                    currentPlayerPosition.latitude,
                    currentPlayerPosition.longitude,
                    nextStation.latitude,
                    nextStation.longitude
                );

                // Player has ARRIVED at the station if within threshold
                // This allows stopping at stations to advance the timetable
                const hasArrivedAtStation = currentDistance <= ARRIVAL_THRESHOLD_METERS;

                if (hasArrivedAtStation) {
                    console.log(`[Timetable] Arrived at station: ${nextStation.destination} (distance: ${Math.round(currentDistance)}m)`);
                    lastArrivedStationIndex = nextStationIndex;
                    closestDistanceToNextStation = Infinity; // Reset for next station
                }
            }
        }

        // First stop logic - time-based since player starts at first station
        const firstStop = timetableData[0];
        const firstDepartureSeconds = timeToSeconds(firstStop.departure);

        if (lastArrivedStationIndex === -1) {
            // Not started yet - check if at first station by time
            if (currentSeconds < firstDepartureSeconds) {
                // Before departure - show departure time, but still provide next station for distance calc
                const nextStation = timetableData.length > 1 ? timetableData[1] : null;
                return {
                    time: firstStop.departure,
                    label: 'DEPARTURE',
                    targetApiName: nextStation ? nextStation.apiName : null,
                    showDistance: true
                };
            } else {
                // Departure time passed - mark as arrived at first station and show next
                lastArrivedStationIndex = 0;
                closestDistanceToNextStation = Infinity;
            }
        }

        // Show next station info (always show the next target)
        const nextStationIndex = lastArrivedStationIndex + 1;
        if (nextStationIndex < timetableData.length) {
            const nextStation = timetableData[nextStationIndex];
            return {
                time: nextStation.arrival,
                label: nextStation.destination,
                targetApiName: nextStation.apiName,
                showDistance: true
            };
        }

        // At last station
        if (lastArrivedStationIndex === timetableData.length - 1) {
            const lastStation = timetableData[lastArrivedStationIndex];
            return { time: lastStation.arrival, label: lastStation.destination, targetApiName: lastStation.apiName, showDistance: false };
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
 * Falls back to direct Haversine distance if route data unavailable
 */
function calculateDistanceAlongRoute(playerLat, playerLon, markerLat, markerLon) {
    // Always calculate direct distance as fallback
    const directDistance = calculateDistance(playerLat, playerLon, markerLat, markerLon);

    if (!loadedRouteData || !loadedRouteData.coordinates || loadedRouteData.coordinates.length === 0) {
        // No route data, use direct distance
        return directDistance;
    }

    const playerIndex = findNearestRouteIndex(playerLat, playerLon);
    const markerIndex = findNearestRouteIndex(markerLat, markerLon);

    if (playerIndex === -1 || markerIndex === -1) {
        return directDistance;
    }

    // If marker is behind player (already passed), use direct distance
    if (markerIndex <= playerIndex) {
        return directDistance;
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
    // Debug logging - log once every 5 seconds
    if (!parseSubscriptionData.lastLog || Date.now() - parseSubscriptionData.lastLog > 5000) {
        parseSubscriptionData.lastLog = Date.now();
        if (rawData && rawData.Entries && rawData.Entries.length > 0) {
            console.log(`[Telemetry] Parsing ${rawData.Entries.length} entries`);
        } else if (rawData && Object.keys(rawData).length === 0) {
            console.log('[Telemetry] Received empty rawData object');
        } else {
            console.log('[Telemetry] rawData has no Entries:', rawData ? Object.keys(rawData) : 'null');
        }
    }

    // Get conversion factors based on user's unit preference
    const { speedConversionFactor, distanceConversionFactor, units } = getConversionFactors();

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
        },
        // Door status
        doorFrontRight: null,
        doorFrontLeft: null,
        // Reverser position (0=reverse, 1=neutral, 2=forward, -1=handle removed)
        reverser: null,
        // Distance units preference for frontend display
        distanceUnits: units,
        // Temperature units preference for frontend display
        temperatureUnits: getTemperatureUnits(),
        // Camera mode (e.g., FirstPerson_Standing when walking)
        cameraMode: null
    };

    if (rawData.Entries && rawData.Entries.length > 0) {
        for (const entry of rawData.Entries) {
            if (entry.NodeValid && entry.Values) {
                // Extract GPS coordinates and camera mode
                if (entry.Path === 'DriverAid.PlayerInfo') {
                    if (entry.Values.geoLocation &&
                        typeof entry.Values.geoLocation.longitude === 'number' &&
                        typeof entry.Values.geoLocation.latitude === 'number') {

                        const lat = entry.Values.geoLocation.latitude;
                        const lng = entry.Values.geoLocation.longitude;

                        // Filter out stale Chatham position (game default when no real position)
                        const isStalePosition = lat === 51.380108707397724 && lng === 0.5219243867730494;

                        if (!isStalePosition) {
                            currentPlayerPosition = {
                                longitude: lng,
                                latitude: lat
                            };
                            streamData.playerPosition = currentPlayerPosition;
                            // Store geoLocation for recording after all entries are processed
                            streamData._geoLocation = entry.Values.geoLocation;
                        }
                    }
                    // Extract camera mode (e.g., FirstPerson_Standing when walking)
                    if (entry.Values.cameraMode) {
                        streamData.cameraMode = entry.Values.cameraMode;
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
                // Extract direction and reverser from HUD_GetDirection
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetDirection') {
                    if (entry.Values['Direction'] !== undefined) {
                        streamData.direction = entry.Values['Direction'];
                    }
                    // Also use this for reverser (IsActive: false = handle removed, Direction: -1=reverse, 0=neutral, 1=forward)
                    if (entry.Values['IsActive'] === false) {
                        streamData.reverser = -1; // Handle removed (show X)
                    } else if (entry.Values['Direction'] !== undefined) {
                        const direction = entry.Values['Direction'];
                        if (direction < 0) {
                            streamData.reverser = 0; // Reverse
                        } else if (direction === 0) {
                            streamData.reverser = 1; // Neutral
                        } else {
                            streamData.reverser = 2; // Forward
                        }
                    }
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
                        const rawLimit = entry.Values['speedLimit']['value'] * speedConversionFactor;
                        // Sanity check: ignore garbage values (valid train speeds are under 500)
                        if (rawLimit >= 0 && rawLimit < 500) {
                            streamData.limit = Math.round(rawLimit);
                        }
                    }
                    if (entry.Values['gradient'] !== undefined) {
                        streamData.incline = parseFloat(entry.Values['gradient'].toFixed(1)); // Rounded for display
                        streamData._rawGradient = entry.Values['gradient']; // Raw value for recording
                    }
                    if (entry.Values['nextSpeedLimit'] && entry.Values['nextSpeedLimit']['value']) {
                        const rawNextLimit = entry.Values['nextSpeedLimit']['value'] * speedConversionFactor;
                        // Sanity check: ignore garbage values
                        if (rawNextLimit >= 0 && rawNextLimit < 500) {
                            streamData.nextSpeedLimit = Math.round(rawNextLimit);
                        }
                    }
                    if (entry.Values['distanceToNextSpeedLimit'] !== undefined) {
                        const rawDistance = entry.Values['distanceToNextSpeedLimit'] / distanceConversionFactor;
                        // Sanity check: ignore garbage values (reasonable max ~100km/60mi)
                        if (rawDistance >= 0 && rawDistance < 100000) {
                            streamData.distanceToNextSpeedLimit = Math.round(rawDistance);
                        }
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
                // Extract front right door status (CurrentDrivableActor)
                else if (entry.Path === 'CurrentDrivableActor/PassengerDoor_FR.Function.GetCurrentInputValue' && entry.Values['ReturnValue'] !== undefined) {
                    streamData.doorFrontRight = entry.Values['ReturnValue'];
                }
                // Extract front left door status (CurrentDrivableActor)
                else if (entry.Path === 'CurrentDrivableActor/PassengerDoor_FL.Function.GetCurrentInputValue' && entry.Values['ReturnValue'] !== undefined) {
                    streamData.doorFrontLeft = entry.Values['ReturnValue'];
                }
                // Fallback: Extract back right door status (CurrentFormation - some trains use this)
                else if (entry.Path === 'CurrentFormation/1/Door_PassengerDoor_BR.Function.GetCurrentOutputValue' && entry.Values['ReturnValue'] !== undefined) {
                    if (streamData.doorFrontRight === null) {
                        streamData.doorFrontRight = entry.Values['ReturnValue'];
                    }
                }
                // Fallback: Extract back left door status (CurrentFormation - some trains use this)
                else if (entry.Path === 'CurrentFormation/1/Door_PassengerDoor_BL.Function.GetCurrentOutputValue' && entry.Values['ReturnValue'] !== undefined) {
                    if (streamData.doorFrontLeft === null) {
                        streamData.doorFrontLeft = entry.Values['ReturnValue'];
                    }
                }
                // Fallback: DriverInput reverser for diesel/steam trains
                else if (entry.Path === 'DriverInput/Reverser.Function.GetCurrentNotchIndex' && entry.Values['ReturnValue'] !== undefined) {
                    if (streamData.reverser === null) {
                        streamData.reverser = entry.Values['ReturnValue'];
                    }
                }
                // Fallback: CurrentDrivableActor reverser
                else if (entry.Path === 'CurrentDrivableActor/Reverser.Function.GetCurrentNotchIndex' && entry.Values['ReturnValue'] !== undefined) {
                    if (streamData.reverser === null) {
                        streamData.reverser = entry.Values['ReturnValue'];
                    }
                }
                // Fallback: VirtualRailDriver.Reverser (0=forward, 0.5=neutral, 1=reverse)
                else if (entry.Path === 'VirtualRailDriver.Reverser' && entry.Values['Reverser'] !== undefined && streamData.reverser === null) {
                    const reverserValue = entry.Values['Reverser'];
                    if (reverserValue > 0.75) {
                        streamData.reverser = 0; // Reverse (value ~1)
                    } else if (reverserValue > 0.25) {
                        streamData.reverser = 1; // Neutral (value ~0.5)
                    } else {
                        streamData.reverser = 2; // Forward (value ~0)
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
        // Use targetApiName from display, or find the next station directly if we have a valid index
        let targetApiName = timetableDisplay.targetApiName;

        // If no targetApiName but we have a valid station index, get it from timetable directly
        if (!targetApiName && lastArrivedStationIndex >= 0 && lastArrivedStationIndex < timetableData.length - 1) {
            const nextStation = timetableData[lastArrivedStationIndex + 1];
            if (nextStation) {
                targetApiName = nextStation.apiName;
            }
        }

        // Also try direct lookup by index if we have a valid arrived index
        const directTargetIndex = lastArrivedStationIndex + 1;
        let nextStation = null;

        if (targetApiName) {
            nextStation = getNextTimetableStation(targetApiName);
        }

        // Fallback: if no station found by apiName, try direct index lookup
        if (!nextStation && directTargetIndex >= 0 && directTargetIndex < timetableData.length) {
            const directStation = timetableData[directTargetIndex];
            if (directStation && directStation.latitude && directStation.longitude) {
                nextStation = {
                    name: directStation.destination,
                    latitude: directStation.latitude,
                    longitude: directStation.longitude,
                    arrival: directStation.arrival,
                    departure: directStation.departure,
                    platform: directStation.platform,
                    index: directStation.index
                };
            }
        }

        if (nextStation && nextStation.latitude && nextStation.longitude && currentPlayerPosition) {
            // Use streamData.playerPosition if available (freshly updated this tick), otherwise fall back to global
            const posToUse = streamData.playerPosition || currentPlayerPosition;

            const distance = calculateDistanceAlongRoute(
                posToUse.latitude,
                posToUse.longitude,
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
    lastArrivedStationIndex = -1;
    closestDistanceToNextStation = Infinity;
    console.log('Route data cleared');
}

/**
 * Get current player position
 */
function getPlayerPosition() {
    return currentPlayerPosition;
}

/**
 * Get timetable items for test selector
 */
function getTimetableItems() {
    return {
        items: timetableData,
        currentIndex: lastArrivedStationIndex
    };
}

/**
 * Set timetable index (for testing)
 */
function setTimetableIndex(index) {
    if (index >= -1 && index < timetableData.length) {
        lastArrivedStationIndex = index;
        closestDistanceToNextStation = Infinity;
        console.log(`[Timetable Test] Index set to ${index}`);
        return true;
    }
    return false;
}

/**
 * Update timetable entry coordinates (for SAVE LOC button)
 */
async function updateTimetableCoordinates(req, res) {
    const { sendJson, parseBody } = require('../utils/http');
    const { entryDb } = require('../db');

    try {
        const body = await parseBody(req);
        const { entryId, latitude, longitude } = body;

        if (!entryId) {
            sendJson(res, { success: false, error: 'Entry ID is required' }, 400);
            return;
        }

        if (latitude === undefined || longitude === undefined) {
            sendJson(res, { success: false, error: 'Latitude and longitude are required' }, 400);
            return;
        }

        // Update coordinates in database using the entryDb method
        entryDb.updateCoordinatesById(entryId, latitude, longitude);

        // Also update the local timetableData cache if the entry is found
        const entryIndex = timetableData.findIndex(e => e.id === entryId);
        if (entryIndex !== -1) {
            timetableData[entryIndex].latitude = latitude;
            timetableData[entryIndex].longitude = longitude;
        }

        console.log(`[SAVE LOC] Updated entry ${entryId} coordinates: lat=${latitude}, lng=${longitude}`);
        sendJson(res, { success: true });
    } catch (err) {
        console.error('[SAVE LOC] Error updating coordinates:', err);
        sendJson(res, { success: false, error: err.message }, 500);
    }
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
    calculateDistanceAlongRoute,
    getTimetableItems,
    setTimetableIndex,
    updateTimetableCoordinates
};
