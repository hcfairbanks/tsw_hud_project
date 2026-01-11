'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson } = require('../utils/http');
const { timetableDb, entryDb, timetableCoordinateDb, timetableMarkerDb } = require('../db');

// Recording state
let isRecording = false;
let isPaused = false;
let currentTimetableId = null;
let routeCoordinates = [];
let discoveredMarkers = [];
let processedMarkers = new Set();
let currentPlayerPosition = null;
let currentGradient = null;
let currentHeight = null;
let recordingStartTime = null;
let routeOutputFilePath = null;

// Get recording data directory
const recordingDataDir = path.join(__dirname, '..', 'recording_data');

/**
 * Get current recording status
 */
function getStatus(req, res) {
    sendJson(res, {
        isRecording,
        isPaused,
        currentTimetableId,
        coordinateCount: routeCoordinates.length,
        markerCount: discoveredMarkers.length,
        recordingStartTime,
        outputFile: routeOutputFilePath ? path.basename(routeOutputFilePath) : null
    });
}

/**
 * Start recording for a specific timetable
 */
async function start(req, res, timetableId) {
    if (isRecording && !isPaused) {
        sendJson(res, { error: 'Recording already in progress' }, 400);
        return;
    }

    // Validate timetable exists
    const timetable = timetableDb.getById(timetableId);
    if (!timetable) {
        sendJson(res, { error: 'Timetable not found' }, 404);
        return;
    }

    // Get timetable entries
    const entries = entryDb.getByTimetableId(timetableId);

    // Create recording data directory if it doesn't exist
    if (!fs.existsSync(recordingDataDir)) {
        fs.mkdirSync(recordingDataDir, { recursive: true });
    }

    // Check if we're resuming a paused recording
    if (isPaused && currentTimetableId === timetableId) {
        // Resume from paused state
        isPaused = false;
        isRecording = true;
        console.log(`Resumed recording for timetable ${timetableId}`);
        sendJson(res, {
            success: true,
            message: 'Recording resumed',
            timetableId,
            coordinateCount: routeCoordinates.length,
            markerCount: discoveredMarkers.length
        });
        return;
    }

    // Start new recording (or resume from file if exists)
    currentTimetableId = timetableId;

    // Generate output file path
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const fileName = `raw_data_timetable_${timetableId}_${timestamp}.json`;
    routeOutputFilePath = path.join(recordingDataDir, fileName);

    // Check for existing recording file to resume
    const existingFiles = fs.readdirSync(recordingDataDir)
        .filter(f => f.startsWith(`raw_data_timetable_${timetableId}_`) && f.endsWith('.json'))
        .sort()
        .reverse();

    if (existingFiles.length > 0) {
        // Resume from existing file
        routeOutputFilePath = path.join(recordingDataDir, existingFiles[0]);
        try {
            const existingData = JSON.parse(fs.readFileSync(routeOutputFilePath, 'utf8'));
            if (existingData.coordinates && Array.isArray(existingData.coordinates)) {
                routeCoordinates = existingData.coordinates;
                console.log(`Resuming recording: ${routeCoordinates.length} existing coordinates loaded`);
            }
            if (existingData.markers && Array.isArray(existingData.markers)) {
                discoveredMarkers = existingData.markers;
                discoveredMarkers.forEach(m => processedMarkers.add(m.stationName));
                console.log(`Resuming recording: ${discoveredMarkers.length} existing markers loaded`);
            }
        } catch (err) {
            console.warn('Could not load existing data, starting fresh:', err.message);
            routeCoordinates = [];
            discoveredMarkers = [];
            processedMarkers.clear();
        }
    } else {
        // Fresh start
        routeCoordinates = [];
        discoveredMarkers = [];
        processedMarkers.clear();
    }

    isRecording = true;
    isPaused = false;
    recordingStartTime = Date.now();

    // Save initial data with timetable info
    saveRouteData(timetable, entries);

    console.log(`Started recording for timetable ${timetableId}: ${timetable.service_name}`);

    sendJson(res, {
        success: true,
        message: 'Recording started',
        timetableId,
        serviceName: timetable.service_name,
        outputFile: path.basename(routeOutputFilePath)
    });
}

/**
 * Stop recording and save final data
 */
function stop(req, res) {
    if (!isRecording && !isPaused) {
        sendJson(res, { error: 'No recording in progress' }, 400);
        return;
    }

    // Save final data to JSON file
    let timetable = null;
    let routeId = null;
    if (currentTimetableId) {
        timetable = timetableDb.getById(currentTimetableId);
        const entries = entryDb.getByTimetableId(currentTimetableId);
        saveRouteData(timetable, entries);
        routeId = timetable?.route_id;
    }

    // Save to database using timetable_id
    let dbSaved = false;
    if (currentTimetableId && routeCoordinates.length > 0) {
        try {
            // Save coordinates to timetable_coordinates table
            const coordCount = timetableCoordinateDb.bulkInsert(currentTimetableId, routeCoordinates);
            console.log(`Saved ${coordCount} coordinates to database for timetable ${currentTimetableId}`);

            // Save markers to timetable_markers table
            if (discoveredMarkers.length > 0) {
                const markerCount = timetableMarkerDb.bulkInsert(currentTimetableId, discoveredMarkers);
                console.log(`Saved ${markerCount} markers to database for timetable ${currentTimetableId}`);
            }
            dbSaved = true;
        } catch (err) {
            console.error('Failed to save to database:', err);
        }
    }

    const result = {
        success: true,
        message: 'Recording stopped',
        timetableId: currentTimetableId,
        routeId: routeId,
        coordinateCount: routeCoordinates.length,
        markerCount: discoveredMarkers.length,
        savedToDatabase: dbSaved,
        outputFile: routeOutputFilePath ? path.basename(routeOutputFilePath) : null
    };

    // Reset state
    isRecording = false;
    isPaused = false;
    currentTimetableId = null;
    routeCoordinates = [];
    discoveredMarkers = [];
    processedMarkers.clear();
    currentPlayerPosition = null;
    currentGradient = null;
    currentHeight = null;
    recordingStartTime = null;
    routeOutputFilePath = null;

    console.log('Recording stopped');
    sendJson(res, result);
}

/**
 * Pause recording (saves state but stops collecting)
 */
function pause(req, res) {
    if (!isRecording) {
        sendJson(res, { error: 'No recording in progress' }, 400);
        return;
    }

    if (isPaused) {
        sendJson(res, { error: 'Recording already paused' }, 400);
        return;
    }

    // Save current data
    if (currentTimetableId) {
        const timetable = timetableDb.getById(currentTimetableId);
        const entries = entryDb.getByTimetableId(currentTimetableId);
        saveRouteData(timetable, entries);
    }

    isPaused = true;
    console.log(`Recording paused for timetable ${currentTimetableId}`);

    sendJson(res, {
        success: true,
        message: 'Recording paused',
        timetableId: currentTimetableId,
        coordinateCount: routeCoordinates.length,
        markerCount: discoveredMarkers.length
    });
}

/**
 * Resume paused recording
 */
function resume(req, res) {
    if (!isPaused) {
        sendJson(res, { error: 'Recording is not paused' }, 400);
        return;
    }

    isPaused = false;
    console.log(`Recording resumed for timetable ${currentTimetableId}`);

    sendJson(res, {
        success: true,
        message: 'Recording resumed',
        timetableId: currentTimetableId,
        coordinateCount: routeCoordinates.length,
        markerCount: discoveredMarkers.length
    });
}

/**
 * Get current route data for the record map
 */
function getRouteData(req, res) {
    const timetable = currentTimetableId ? timetableDb.getById(currentTimetableId) : null;
    const entries = currentTimetableId ? entryDb.getByTimetableId(currentTimetableId) : [];

    // Build timetable data array for the map
    const timetableData = entries.map((entry, index) => ({
        index,
        destination: entry.location || entry.details || 'Unknown',
        arrival: entry.time1 || '',
        departure: entry.time2 || '',
        platform: entry.platform || '',
        apiName: entry.location || '',
        latitude: entry.latitude ? parseFloat(entry.latitude) : null,
        longitude: entry.longitude ? parseFloat(entry.longitude) : null
    }));

    sendJson(res, {
        isRecording,
        isPaused,
        timetableId: currentTimetableId,
        routeName: timetable ? timetable.service_name : 'No Recording',
        coordinates: routeCoordinates,
        markers: discoveredMarkers,
        timetable: timetableData,
        currentPosition: currentPlayerPosition
    });
}

/**
 * Save coordinates to a timetable entry
 */
async function saveTimetableCoords(req, res) {
    let body = '';

    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', () => {
        try {
            const { index, latitude, longitude } = JSON.parse(body);

            // Validate the data
            if (typeof index !== 'number' || typeof latitude !== 'number' || typeof longitude !== 'number') {
                sendJson(res, { success: false, error: 'Invalid data types' }, 400);
                return;
            }

            if (!currentTimetableId) {
                sendJson(res, { success: false, error: 'No recording in progress' }, 400);
                return;
            }

            // Get timetable entries
            const entries = entryDb.getByTimetableId(currentTimetableId);

            if (index < 0 || index >= entries.length) {
                sendJson(res, { success: false, error: `Invalid index ${index}. Must be between 0 and ${entries.length - 1}` }, 400);
                return;
            }

            // Update the entry with coordinates
            const entry = entries[index];
            entry.latitude = latitude.toString();
            entry.longitude = longitude.toString();
            entryDb.update(entry.id, entry);

            console.log(`Updated timetable entry ${index} with coordinates: ${latitude}, ${longitude}`);

            // Also save to the route file
            const timetable = timetableDb.getById(currentTimetableId);
            const updatedEntries = entryDb.getByTimetableId(currentTimetableId);
            saveRouteData(timetable, updatedEntries);

            sendJson(res, {
                success: true,
                message: `Updated timetable index ${index}`,
                destination: entry.location || entry.details || 'Unknown'
            });
        } catch (err) {
            sendJson(res, { success: false, error: 'Invalid JSON data' }, 400);
        }
    });
}

/**
 * Process coordinate data from telemetry stream
 * Called by the stream controller when recording is active
 */
function processCoordinate(geoLocation, gradient, height) {
    if (!isRecording || isPaused) return;

    if (!geoLocation || typeof geoLocation.latitude !== 'number' || typeof geoLocation.longitude !== 'number') {
        return;
    }

    const coordinate = {
        longitude: geoLocation.longitude,
        latitude: geoLocation.latitude
    };

    if (height !== null && height !== undefined) {
        coordinate.height = height;
        currentHeight = height;
    }

    if (gradient !== null && gradient !== undefined) {
        coordinate.gradient = gradient;
        currentGradient = gradient;
    }

    // Update current player position
    currentPlayerPosition = coordinate;

    // Only add if coordinate is different from last one
    const lastCoord = routeCoordinates.length > 0 ? routeCoordinates[routeCoordinates.length - 1] : null;
    if (!lastCoord || lastCoord.longitude !== coordinate.longitude || lastCoord.latitude !== coordinate.latitude) {
        routeCoordinates.push(coordinate);

        // Save to file periodically (every 100 coordinates)
        if (routeCoordinates.length % 100 === 0) {
            const timetable = timetableDb.getById(currentTimetableId);
            const entries = entryDb.getByTimetableId(currentTimetableId);
            saveRouteData(timetable, entries);
            console.log(`Route collection: ${routeCoordinates.length} coordinates, ${discoveredMarkers.length} markers`);
        }
    }
}

/**
 * Process marker data from telemetry stream
 * Called by the stream controller when recording is active
 */
function processMarker(station, distanceCM) {
    if (!isRecording || isPaused || !currentPlayerPosition) return;

    const markerName = station.stationName || station.markerName;
    if (!markerName) return;

    const distanceMeters = distanceCM / 100;

    // Check if we're passing over this station (within 10 meters)
    if (distanceCM < 1000) {
        // Get timetable entries to check if this is a timetable station
        const entries = entryDb.getByTimetableId(currentTimetableId);
        const timetableStop = entries.find(e => e.location === markerName || e.details === markerName);

        if (timetableStop) {
            // Find this marker in discoveredMarkers
            const existingMarker = discoveredMarkers.find(m => m.stationName === markerName);
            if (existingMarker) {
                // Record/update the on-spot position
                existingMarker.onspot_latitude = currentPlayerPosition.latitude;
                existingMarker.onspot_longitude = currentPlayerPosition.longitude;
                existingMarker.onspot_timestamp = new Date().toISOString();
                existingMarker.spoton_distance = distanceMeters;

                // Save to file
                const timetable = timetableDb.getById(currentTimetableId);
                saveRouteData(timetable, entries);

                console.log(`Recording position for ${markerName} at ${distanceMeters.toFixed(2)}m`);
            }
        }
    }

    // Add new marker if not already processed
    if (!processedMarkers.has(markerName)) {
        const marker = {
            stationName: markerName,
            markerType: station.markerType || 'Station',
            detectedAt: {
                longitude: currentPlayerPosition.longitude,
                latitude: currentPlayerPosition.latitude
            },
            distanceAheadMeters: distanceMeters,
            timestamp: new Date().toISOString()
        };

        if (typeof station.platformLength === 'number') {
            marker.platformLength = station.platformLength;
        }

        discoveredMarkers.push(marker);
        processedMarkers.add(markerName);

        // Save to file
        const timetable = timetableDb.getById(currentTimetableId);
        const entries = entryDb.getByTimetableId(currentTimetableId);
        saveRouteData(timetable, entries);

        console.log(`Found marker: ${markerName} (${distanceMeters.toFixed(0)}m ahead)`);
    }
}

/**
 * Save route data to JSON file
 */
function saveRouteData(timetable, entries) {
    if (!routeOutputFilePath) return;

    // Build timetable data array
    const timetableData = entries.map((entry, index) => ({
        index,
        destination: entry.location || entry.details || 'Unknown',
        arrival: entry.time1 || '',
        departure: entry.time2 || '',
        platform: entry.platform || '',
        apiName: entry.location || '',
        latitude: entry.latitude ? parseFloat(entry.latitude) : null,
        longitude: entry.longitude ? parseFloat(entry.longitude) : null
    }));

    const output = {
        routeName: timetable ? timetable.service_name : 'Unknown',
        timetableId: currentTimetableId,
        totalPoints: routeCoordinates.length,
        totalMarkers: discoveredMarkers.length,
        duration: recordingStartTime ? Date.now() - recordingStartTime : 0,
        coordinates: routeCoordinates,
        markers: discoveredMarkers,
        timetable: timetableData
    };

    try {
        fs.writeFileSync(routeOutputFilePath, JSON.stringify(output, null, 2));
    } catch (err) {
        console.error('Failed to save route data:', err.message);
    }
}

/**
 * Check if recording is active (for use by stream controller)
 */
function isRecordingActive() {
    return isRecording && !isPaused;
}

/**
 * Get list of recorded files
 */
function listRecordings(req, res) {
    if (!fs.existsSync(recordingDataDir)) {
        sendJson(res, []);
        return;
    }

    const files = fs.readdirSync(recordingDataDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const filePath = path.join(recordingDataDir, f);
            const stats = fs.statSync(filePath);
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                return {
                    filename: f,
                    routeName: data.routeName || 'Unknown',
                    timetableId: data.timetableId,
                    coordinateCount: data.totalPoints || 0,
                    markerCount: data.totalMarkers || 0,
                    size: stats.size,
                    modified: stats.mtime
                };
            } catch (err) {
                return {
                    filename: f,
                    error: 'Could not parse file',
                    size: stats.size,
                    modified: stats.mtime
                };
            }
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));

    sendJson(res, files);
}

/**
 * Get a specific recording file
 */
function getRecordingFile(req, res, filename) {
    if (!filename) {
        sendJson(res, { error: 'Filename is required' }, 400);
        return;
    }

    const filePath = path.join(recordingDataDir, filename);
    if (!fs.existsSync(filePath)) {
        sendJson(res, { error: 'File not found' }, 404);
        return;
    }

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        sendJson(res, data);
    } catch (err) {
        sendJson(res, { error: 'Could not read file' }, 500);
    }
}

module.exports = {
    getStatus,
    start,
    stop,
    pause,
    resume,
    getRouteData,
    saveTimetableCoords,
    processCoordinate,
    processMarker,
    isRecordingActive,
    listRecordings,
    getRecordingFile
};
