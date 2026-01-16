'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson } = require('../utils/http');
const { timetableDb, entryDb, stationMappingDb } = require('../db');
const { preprocessTimetableEntries } = require('./processingController');
const { buildTimetableExportJson } = require('./timetableController');

// Recording configuration
const SAVE_FREQUENCY = 1; // Save to file every N coordinates (1 = every coordinate, 100 = every 100th)

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
let savedTimetableCoords = new Map(); // Stores timetable entry coordinates during recording session only

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
    // Ensure timetableId is a number for consistent comparison
    const numTimetableId = parseInt(timetableId, 10);

    // If already recording the same timetable (not paused), just return success
    if (isRecording && !isPaused && currentTimetableId === numTimetableId) {
        console.log(`Recording already active for timetable ${numTimetableId}`);
        sendJson(res, {
            success: true,
            message: 'Recording already active',
            timetableId: numTimetableId,
            coordinateCount: routeCoordinates.length,
            markerCount: discoveredMarkers.length
        });
        return;
    }

    // If recording a different timetable, reject
    if (isRecording && !isPaused && currentTimetableId !== numTimetableId) {
        sendJson(res, { error: 'Recording already in progress for a different timetable' }, 400);
        return;
    }

    // Validate timetable exists
    const timetable = timetableDb.getById(numTimetableId);
    if (!timetable) {
        sendJson(res, { error: 'Timetable not found' }, 404);
        return;
    }

    // Get timetable entries
    const entries = entryDb.getByTimetableId(numTimetableId);

    // Create recording data directory if it doesn't exist
    if (!fs.existsSync(recordingDataDir)) {
        fs.mkdirSync(recordingDataDir, { recursive: true });
    }

    // Check if we're resuming a paused recording
    if (isPaused && currentTimetableId === numTimetableId) {
        // Resume from paused state
        isPaused = false;
        isRecording = true;
        console.log(`Resumed recording for timetable ${numTimetableId}`);
        sendJson(res, {
            success: true,
            message: 'Recording resumed',
            timetableId: numTimetableId,
            coordinateCount: routeCoordinates.length,
            markerCount: discoveredMarkers.length
        });
        return;
    }

    // Start new recording (or resume from file if exists)
    currentTimetableId = numTimetableId;

    // Generate output file path
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const fileName = `raw_data_timetable_${numTimetableId}_${timestamp}.json`;
    routeOutputFilePath = path.join(recordingDataDir, fileName);

    // Check for existing recording file to resume
    const existingFiles = fs.readdirSync(recordingDataDir)
        .filter(f => f.startsWith(`raw_data_timetable_${numTimetableId}_`) && f.endsWith('.json'))
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
            // Restore saved timetable coordinates from the file
            savedTimetableCoords.clear();
            if (existingData.timetable && Array.isArray(existingData.timetable)) {
                existingData.timetable.forEach((entry, idx) => {
                    if (entry.latitude != null && entry.longitude != null) {
                        savedTimetableCoords.set(idx, {
                            latitude: entry.latitude,
                            longitude: entry.longitude
                        });
                    }
                });
                console.log(`Resuming recording: ${savedTimetableCoords.size} saved station coordinates loaded`);
            }
        } catch (err) {
            console.warn('Could not load existing data, starting fresh:', err.message);
            routeCoordinates = [];
            discoveredMarkers = [];
            processedMarkers.clear();
            savedTimetableCoords.clear();
        }
    } else {
        // Fresh start
        routeCoordinates = [];
        discoveredMarkers = [];
        processedMarkers.clear();
        savedTimetableCoords.clear();
    }

    isRecording = true;
    isPaused = false;
    recordingStartTime = Date.now();

    // Save initial data with timetable info
    saveRouteData(timetable, entries);

    console.log(`Started recording for timetable ${numTimetableId}: ${timetable.service_name}`);

    sendJson(res, {
        success: true,
        message: 'Recording started',
        timetableId: numTimetableId,
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

    // Save final data to JSON file only (not database)
    let timetable = null;
    let routeId = null;
    if (currentTimetableId) {
        timetable = timetableDb.getById(currentTimetableId);
        const entries = entryDb.getByTimetableId(currentTimetableId);
        saveRouteData(timetable, entries);
        routeId = timetable?.route_id;
    }

    const result = {
        success: true,
        message: 'Recording stopped',
        timetableId: currentTimetableId,
        routeId: routeId,
        coordinateCount: routeCoordinates.length,
        markerCount: discoveredMarkers.length,
        outputFile: routeOutputFilePath ? path.basename(routeOutputFilePath) : null
    };

    // Reset state
    isRecording = false;
    isPaused = false;
    currentTimetableId = null;
    routeCoordinates = [];
    discoveredMarkers = [];
    processedMarkers.clear();
    savedTimetableCoords.clear();
    currentPlayerPosition = null;
    currentGradient = null;
    currentHeight = null;
    recordingStartTime = null;
    routeOutputFilePath = null;

    console.log('Recording stopped');
    sendJson(res, result);
}

/**
 * Reset all recording state (for testing)
 */
function reset(req, res) {
    // Reset all state without saving
    isRecording = false;
    isPaused = false;
    currentTimetableId = null;
    routeCoordinates = [];
    discoveredMarkers = [];
    processedMarkers.clear();
    savedTimetableCoords.clear();
    currentPlayerPosition = null;
    currentGradient = null;
    currentHeight = null;
    recordingStartTime = null;
    routeOutputFilePath = null;

    console.log('Recording state reset');
    sendJson(res, { success: true, message: 'Recording state reset' });
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
 * Returns data from the in-memory recording state, not from the database
 */
function getRouteData(req, res) {
    const timetable = currentTimetableId ? timetableDb.getById(currentTimetableId) : null;
    const entries = currentTimetableId ? entryDb.getByTimetableId(currentTimetableId) : [];

    // Get station name mapping for display names
    let stationNameMapping = {};
    if (timetable && timetable.route_id) {
        stationNameMapping = stationMappingDb.getMappingObject(timetable.route_id);
    } else {
        stationNameMapping = stationMappingDb.getMappingObject(null);
    }

    // Use preprocessTimetableEntries to get proper station list (same as saveRouteData)
    const processedEntries = preprocessTimetableEntries(entries, stationNameMapping);

    // Build timetable data array - use coordinates from savedTimetableCoords (recording session only)
    const timetableData = processedEntries.map((entry, index) => {
        const savedCoords = savedTimetableCoords.get(index);
        return {
            index: entry.index,
            destination: entry.destination,
            arrival: entry.arrival || '',
            departure: entry.departure || '',
            platform: entry.platform || '',
            apiName: entry.apiName || '',
            latitude: savedCoords ? savedCoords.latitude : null,
            longitude: savedCoords ? savedCoords.longitude : null
        };
    });

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
 * NOTE: Only saves to the recording JSON file, NOT to the database
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

            // Get timetable entries to validate index and get destination name
            const entries = entryDb.getByTimetableId(currentTimetableId);
            const timetable = timetableDb.getById(currentTimetableId);

            // Get station name mapping
            let stationNameMapping = {};
            if (timetable && timetable.route_id) {
                stationNameMapping = stationMappingDb.getMappingObject(timetable.route_id);
            } else {
                stationNameMapping = stationMappingDb.getMappingObject(null);
            }

            // Process entries to get proper station list
            const processedEntries = preprocessTimetableEntries(entries, stationNameMapping);

            if (index < 0 || index >= processedEntries.length) {
                sendJson(res, { success: false, error: `Invalid index ${index}. Must be between 0 and ${processedEntries.length - 1}` }, 400);
                return;
            }

            // Save coordinates to in-memory map (not database)
            savedTimetableCoords.set(index, { latitude, longitude });

            console.log(`Saved timetable entry ${index} coordinates to recording: ${latitude}, ${longitude}`);

            // Save to the route file
            saveRouteData(timetable, entries);

            sendJson(res, {
                success: true,
                message: `Saved coordinates for index ${index}`,
                destination: processedEntries[index].destination
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

    // Default gradient to 0 if not provided
    coordinate.gradient = (gradient !== null && gradient !== undefined) ? gradient : 0;
    if (gradient !== null && gradient !== undefined) {
        currentGradient = gradient;
    }

    // Update current player position
    currentPlayerPosition = coordinate;

    // Only add if coordinate is different from last one
    const lastCoord = routeCoordinates.length > 0 ? routeCoordinates[routeCoordinates.length - 1] : null;
    if (!lastCoord || lastCoord.longitude !== coordinate.longitude || lastCoord.latitude !== coordinate.latitude) {
        routeCoordinates.push(coordinate);

        // Save to file periodically based on SAVE_FREQUENCY
        if (routeCoordinates.length % SAVE_FREQUENCY === 0) {
            const timetable = timetableDb.getById(currentTimetableId);
            const entries = entryDb.getByTimetableId(currentTimetableId);
            saveRouteData(timetable, entries);
            if (SAVE_FREQUENCY >= 100) {
                console.log(`Route collection: ${routeCoordinates.length} coordinates, ${discoveredMarkers.length} markers`);
            }
        }
    }
}

/**
 * Process marker data from telemetry stream
 * Called by the stream controller when recording is active
 *
 * Recording logic:
 * - First encounter: Record detectedAt (our position) + distanceAheadMeters + timestamp (never overwrite)
 * - Every subsequent encounter: Update onspot_latitude, onspot_longitude, onspot_distance (always latest)
 *
 * This allows post-processing to calculate actual marker position using the recorded path
 * and the final onspot_* values (which have the smallest distance to the marker).
 */
function processMarker(station, distanceCM) {
    if (!isRecording || isPaused || !currentPlayerPosition) return;

    const markerName = station.stationName || station.markerName;
    if (!markerName) return;

    const distanceMeters = distanceCM / 100;

    // Check if marker already exists
    const existingMarker = discoveredMarkers.find(m => m.stationName === markerName);

    if (existingMarker) {
        // Marker already discovered - update onspot_* with latest position and distance
        // These get continuously updated as we get closer to the marker
        existingMarker.onspot_latitude = currentPlayerPosition.latitude;
        existingMarker.onspot_longitude = currentPlayerPosition.longitude;
        existingMarker.onspot_timestamp = new Date().toISOString();
        existingMarker.onspot_distance = distanceMeters;
    } else {
        // First time seeing this marker - record initial detection data
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

        // Initialize onspot_* with first values (will be updated on subsequent calls)
        marker.onspot_latitude = currentPlayerPosition.latitude;
        marker.onspot_longitude = currentPlayerPosition.longitude;
        marker.onspot_timestamp = new Date().toISOString();
        marker.onspot_distance = distanceMeters;

        discoveredMarkers.push(marker);
        console.log(`Found marker: ${markerName} (${distanceMeters.toFixed(0)}m ahead)`);
    }
}

/**
 * Save route data to JSON file
 * Uses the shared buildTimetableExportJson function from timetableController
 * NOTE: Does NOT auto-populate coordinates - user must manually assign them during recording
 */
function saveRouteData(timetable, entries) {
    if (!routeOutputFilePath) return;

    // Use the shared function to build export JSON
    // Pass in recording-specific data (in-memory coordinates, markers, saved coords)
    // timetableId is already included at the top of the export by buildTimetableExportJson
    const output = buildTimetableExportJson({
        timetable,
        entries,
        coordinates: routeCoordinates,
        markers: discoveredMarkers,
        savedTimetableCoords: savedTimetableCoords,
        includeCsvData: false,  // Recording doesn't need csvData
        includeMarkerProcessing: false  // Recording markers already have their data
    });

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

/**
 * Get recording state for stream inclusion
 * Returns data to be merged into stream output
 */
function getRecordingStateForStream() {
    if (!isRecording && !isPaused) {
        return null;
    }

    const timetable = currentTimetableId ? timetableDb.getById(currentTimetableId) : null;
    const entries = currentTimetableId ? entryDb.getByTimetableId(currentTimetableId) : [];

    // Get station name mapping
    let stationNameMapping = {};
    if (timetable && timetable.route_id) {
        stationNameMapping = stationMappingDb.getMappingObject(timetable.route_id);
    } else {
        stationNameMapping = stationMappingDb.getMappingObject(null);
    }

    // Process entries to get proper station list
    const processedEntries = preprocessTimetableEntries(entries, stationNameMapping);

    // Build timetable data with saved coordinates
    const timetableData = processedEntries.map((entry, idx) => {
        const savedCoords = savedTimetableCoords.get(idx);
        return {
            index: entry.index,
            destination: entry.destination,
            arrival: entry.arrival || '',
            departure: entry.departure || '',
            platform: entry.platform || '',
            apiName: entry.apiName || '',
            latitude: savedCoords ? savedCoords.latitude : null,
            longitude: savedCoords ? savedCoords.longitude : null
        };
    });

    return {
        isRecording,
        isPaused,
        timetableId: currentTimetableId,
        routeName: timetable ? timetable.service_name : 'Unknown',
        coordinateCount: routeCoordinates.length,
        markerCount: discoveredMarkers.length,
        timetable: timetableData
    };
}

/**
 * Check for existing recording file for a timetable
 * Returns the most recent recording file if one exists
 */
function checkExistingRecording(req, res, timetableId) {
    if (!fs.existsSync(recordingDataDir)) {
        sendJson(res, { exists: false });
        return;
    }

    const existingFiles = fs.readdirSync(recordingDataDir)
        .filter(f => f.startsWith(`raw_data_timetable_${timetableId}_`) && f.endsWith('.json'))
        .sort()
        .reverse();

    if (existingFiles.length === 0) {
        sendJson(res, { exists: false });
        return;
    }

    const filePath = path.join(recordingDataDir, existingFiles[0]);
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        sendJson(res, {
            exists: true,
            filename: existingFiles[0],
            routeName: data.routeName || 'Unknown',
            coordinateCount: data.coordinates ? data.coordinates.length : 0,
            markerCount: data.markers ? data.markers.length : 0,
            timetableEntryCount: data.timetable ? data.timetable.length : 0
        });
    } catch (err) {
        sendJson(res, { exists: false, error: 'Could not read file' });
    }
}

/**
 * Check for any existing recording file in the recording_data folder
 * Returns the most recent file regardless of timetable
 */
function checkAnyExistingRecording(req, res) {
    if (!fs.existsSync(recordingDataDir)) {
        sendJson(res, { exists: false });
        return;
    }

    const existingFiles = fs.readdirSync(recordingDataDir)
        .filter(f => f.startsWith('raw_data_timetable_') && f.endsWith('.json'))
        .map(f => {
            const filePath = path.join(recordingDataDir, f);
            const stats = fs.statSync(filePath);
            return { filename: f, mtime: stats.mtime };
        })
        .sort((a, b) => b.mtime - a.mtime); // Sort by modification time, newest first

    if (existingFiles.length === 0) {
        sendJson(res, { exists: false });
        return;
    }

    const mostRecent = existingFiles[0];
    const filePath = path.join(recordingDataDir, mostRecent.filename);

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        sendJson(res, {
            exists: true,
            filename: mostRecent.filename,
            timetableId: data.timetableId || null,
            routeName: data.routeName || 'Unknown',
            coordinateCount: data.coordinates ? data.coordinates.length : 0,
            markerCount: data.markers ? data.markers.length : 0,
            timetableEntryCount: data.timetable ? data.timetable.length : 0,
            modifiedAt: mostRecent.mtime
        });
    } catch (err) {
        sendJson(res, { exists: false, error: 'Could not read file' });
    }
}

/**
 * Load a specific recording file into memory for resuming
 * This allows resuming from a specific file rather than just the most recent
 */
function loadRecordingFile(req, res, filename) {
    if (!filename) {
        sendJson(res, { success: false, error: 'Filename is required' }, 400);
        return;
    }

    const filePath = path.join(recordingDataDir, filename);
    if (!fs.existsSync(filePath)) {
        sendJson(res, { success: false, error: 'File not found' }, 404);
        return;
    }

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Extract timetable ID from filename or data
        const timetableId = data.timetableId || null;

        if (!timetableId) {
            sendJson(res, { success: false, error: 'Could not determine timetable ID from file' }, 400);
            return;
        }

        // Load the data into recording state
        currentTimetableId = timetableId;
        routeOutputFilePath = filePath;

        if (data.coordinates && Array.isArray(data.coordinates)) {
            routeCoordinates = data.coordinates;
        } else {
            routeCoordinates = [];
        }

        if (data.markers && Array.isArray(data.markers)) {
            discoveredMarkers = data.markers;
            processedMarkers.clear();
            discoveredMarkers.forEach(m => processedMarkers.add(m.stationName));
        } else {
            discoveredMarkers = [];
            processedMarkers.clear();
        }

        // Restore saved timetable coordinates
        savedTimetableCoords.clear();
        if (data.timetable && Array.isArray(data.timetable)) {
            data.timetable.forEach((entry, idx) => {
                if (entry.latitude != null && entry.longitude != null) {
                    savedTimetableCoords.set(idx, {
                        latitude: entry.latitude,
                        longitude: entry.longitude
                    });
                }
            });
        }

        // Set state to paused (ready to resume)
        isRecording = true;
        isPaused = true;
        recordingStartTime = Date.now();

        console.log(`Loaded recording file: ${filename}`);
        console.log(`  Coordinates: ${routeCoordinates.length}`);
        console.log(`  Markers: ${discoveredMarkers.length}`);
        console.log(`  Saved stations: ${savedTimetableCoords.size}`);

        sendJson(res, {
            success: true,
            message: 'Recording file loaded',
            timetableId,
            filename,
            coordinateCount: routeCoordinates.length,
            markerCount: discoveredMarkers.length,
            savedStationCount: savedTimetableCoords.size
        });
    } catch (err) {
        console.error('Error loading recording file:', err);
        sendJson(res, { success: false, error: 'Could not parse file: ' + err.message }, 500);
    }
}

module.exports = {
    getStatus,
    start,
    stop,
    reset,
    pause,
    resume,
    getRouteData,
    saveTimetableCoords,
    processCoordinate,
    processMarker,
    isRecordingActive,
    listRecordings,
    getRecordingFile,
    getRecordingStateForStream,
    checkExistingRecording,
    checkAnyExistingRecording,
    loadRecordingFile
};
