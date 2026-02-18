'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson, parseBody } = require('../utils/http');
const { timetableDb, entryDb, stationMappingDb, timetableCoordinateDb, timetableMarkerDb } = require('../db');
const { preprocessTimetableEntries } = require('./processingController');
const { buildTimetableExportJson } = require('./timetableController');
const { processRawData } = require('./routeProcessingController');
const { loadConfig } = require('./configController');

// Recording configuration (hardcoded fallbacks, overridden by user config on recording start)
const SAVE_FREQUENCY = 1; // Save to file every N coordinates (1 = every coordinate, 100 = every 100th)
let currentSaveFrequency = SAVE_FREQUENCY;

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

// Get recording data directories
const recordingDataDir = path.join(__dirname, '..', 'recording_data');
const savedRawDataDir = path.join(__dirname, '..', 'saved_raw_data');
const processedRoutesDir = path.join(__dirname, '..', 'processed_routes');

// Auto-stop configuration (hardcoded fallback, overridden by user config on recording start)
const AUTO_STOP_TIMEOUT_MS = 120000; // 2 minutes in ms (for real-time inactivity)
let currentAutoStopTimeoutMs = AUTO_STOP_TIMEOUT_MS;
let autoStopEnabled = true; // Default to automatic mode
let lastUniqueCoordinateTime = null;
let autoStopCheckInterval = null;
let autoStopped = false; // Flag to notify frontend of auto-stop
let lastTimetableTimeSeconds = null; // Last scheduled time in timetable (in seconds since midnight)
let currentGameTimeSeconds = null; // Current in-game time (in seconds since midnight)

/**
 * Parse time string (HH:MM:SS) to seconds since midnight
 */
function timeStringToSeconds(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':');
    if (parts.length < 2) return null;
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
    return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse ISO8601 time string to seconds since midnight
 * Example: "2024-01-27T05:47:56.149+00:00" -> seconds for 05:47:56
 */
function isoTimeToSeconds(isoStr) {
    if (!isoStr) return null;
    const timePart = isoStr.split('T')[1];
    if (!timePart) return null;
    const timeOnly = timePart.split('.')[0]; // Remove milliseconds and timezone
    return timeStringToSeconds(timeOnly);
}

/**
 * Calculate the last time from timetable entries
 * Returns the latest arrival or departure time in seconds since midnight
 * Handles both DB format (time1/time2) and export format (arrival/departure)
 */
function calculateLastTimetableTime(entries) {
    if (!entries || entries.length === 0) return null;

    let lastTimeSeconds = null;

    for (const entry of entries) {
        // Check arrival time (DB uses time1, export uses arrival)
        const arrivalTime = entry.arrival || entry.time1;
        if (arrivalTime) {
            const arrivalSeconds = timeStringToSeconds(arrivalTime);
            if (arrivalSeconds !== null && (lastTimeSeconds === null || arrivalSeconds > lastTimeSeconds)) {
                lastTimeSeconds = arrivalSeconds;
            }
        }
        // Check departure time (DB uses time2, export uses departure)
        const departureTime = entry.departure || entry.time2;
        if (departureTime) {
            const departureSeconds = timeStringToSeconds(departureTime);
            if (departureSeconds !== null && (lastTimeSeconds === null || departureSeconds > lastTimeSeconds)) {
                lastTimeSeconds = departureSeconds;
            }
        }
    }

    return lastTimeSeconds;
}

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

        // Restart auto-stop timer if in automatic mode
        if (autoStopEnabled) {
            lastUniqueCoordinateTime = Date.now();
            if (!autoStopCheckInterval) {
                autoStopCheckInterval = setInterval(checkAutoStop, 30000);
                console.log('Auto-stop interval started on resume');
            }
        }

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

    // Check for existing INCOMPLETE recording file to resume
    // Only resume from files that are not marked as completed
    const existingFiles = fs.readdirSync(recordingDataDir)
        .filter(f => f.startsWith(`raw_data_timetable_${numTimetableId}_`) && f.endsWith('.json'))
        .sort()
        .reverse();

    let foundIncompleteFile = false;
    for (const file of existingFiles) {
        const filePath = path.join(recordingDataDir, file);
        try {
            const existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            // Skip completed files - only resume from incomplete ones
            if (existingData.completed === true) {
                console.log(`Skipping completed recording file: ${file}`);
                continue;
            }

            // Found an incomplete file - resume from it
            routeOutputFilePath = filePath;
            foundIncompleteFile = true;

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
            break;  // Found incomplete file, stop searching
        } catch (err) {
            console.warn(`Could not parse file ${file}:`, err.message);
            continue;
        }
    }

    if (!foundIncompleteFile) {
        // Fresh start - no incomplete file found
        routeCoordinates = [];
        discoveredMarkers = [];
        processedMarkers.clear();
        savedTimetableCoords.clear();
    }

    isRecording = true;
    isPaused = false;
    recordingStartTime = Date.now();

    // Load recording settings from config
    const recordingConfig = loadConfig();
    currentSaveFrequency = recordingConfig.saveFrequency ?? SAVE_FREQUENCY;
    currentAutoStopTimeoutMs = (recordingConfig.autoStopTimeoutSeconds ?? 120) * 1000;

    // Calculate the last time from the timetable for auto-stop logic
    lastTimetableTimeSeconds = calculateLastTimetableTime(entries);
    if (lastTimetableTimeSeconds !== null) {
        const hours = Math.floor(lastTimetableTimeSeconds / 3600);
        const mins = Math.floor((lastTimetableTimeSeconds % 3600) / 60);
        const secs = lastTimetableTimeSeconds % 60;
        console.log(`Last timetable time: ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
        console.log(`Auto-stop will trigger after this time (in game time) when train is stationary for 2 minutes`);
    }

    // Initialize auto-stop timer if in automatic mode
    console.log(`Auto-stop setup: autoStopEnabled=${autoStopEnabled}, interval exists=${!!autoStopCheckInterval}`);
    if (autoStopEnabled) {
        lastUniqueCoordinateTime = Date.now();
        currentGameTimeSeconds = null; // Will be set when we receive game time
        if (!autoStopCheckInterval) {
            autoStopCheckInterval = setInterval(checkAutoStop, 30000);
            console.log('Auto-stop interval started (30s check interval)');
        } else {
            console.log('Auto-stop interval already exists, resetting timestamp');
        }
    } else {
        console.log('Auto-stop is DISABLED - interval not started');
    }

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
 * Stop recording, process data, save to database, and clean up
 * This is the main "Save" action - everything happens here in the backend
 *
 * Flow:
 * 1. Read raw file from recording_data (there will only be 1 file)
 * 2. Process in memory (stop detection, path simplification, find stops if auto mode)
 * 3. In dev mode, copy raw file to saved_raw_data/
 * 4. Save processed data to database (coordinates, markers, timetable entries)
 * 5. Delete original file from recording_data/
 * 6. In dev mode, export from database to processed_routes/
 * 7. Return success with relevant data
 */
function stop(req, res) {
    if (!isRecording && !isPaused) {
        sendJson(res, { error: 'No recording in progress' }, 400);
        return;
    }

    const config = loadConfig();

    // Capture current state before resetting
    let timetable = null;
    let routeId = null;
    const savedTimetableId = currentTimetableId;
    const savedOutputFile = routeOutputFilePath ? path.basename(routeOutputFilePath) : null;
    const savedCoordCount = routeCoordinates.length;
    const savedMarkerCount = discoveredMarkers.length;

    if (currentTimetableId) {
        timetable = timetableDb.getById(currentTimetableId);
        const entries = entryDb.getByTimetableId(currentTimetableId);
        saveRouteData(timetable, entries, true);  // Mark as completed
        routeId = timetable?.route_id;
    }

    // Reset recording state
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
    lastTimetableTimeSeconds = null;
    currentGameTimeSeconds = null;

    // Clear auto-stop interval
    if (autoStopCheckInterval) {
        clearInterval(autoStopCheckInterval);
        autoStopCheckInterval = null;
    }

    console.log('\n========================================');
    console.log('Recording stopped - beginning save process');
    console.log('========================================\n');

    // ========================================
    // STEP 1: Read and process the raw recording file in memory
    // ========================================
    let rawData = null;
    let processedData = null;
    let rawFilePath = null;

    if (savedOutputFile) {
        rawFilePath = path.join(recordingDataDir, savedOutputFile);

        if (!fs.existsSync(rawFilePath)) {
            console.error(`Raw file not found: ${rawFilePath}`);
            sendJson(res, {
                success: false,
                error: 'Recording file not found',
                timetableId: savedTimetableId
            }, 500);
            return;
        }

        try {
            // Read raw data
            const rawContent = fs.readFileSync(rawFilePath, 'utf8');
            rawData = JSON.parse(rawContent);

            // Process in memory (includes stop detection, path simplification, etc.)
            processedData = processRawData(rawData);

            console.log(`Step 1: Recording processed in memory`);
            console.log(`  - Coordinates: ${rawData.coordinates?.length || 0} -> ${processedData.coordinates?.length || 0} (simplified)`);
            console.log(`  - Markers: ${processedData.markers?.length || 0}`);
            console.log(`  - Timetable entries: ${processedData.timetable?.length || 0}`);
            console.log(`  - Detected stops: ${processedData.detectedStops || 0}`);
        } catch (err) {
            console.error('Error processing recording:', err.message);
            sendJson(res, {
                success: false,
                error: 'Failed to process recording: ' + err.message,
                timetableId: savedTimetableId
            }, 500);
            return;
        }
    }

    let rawDestFilename = null;
    let processedDestFilename = null;

    // ========================================
    // STEP 2: Dev mode - copy RAW file to saved_raw_data
    // ========================================
    if (config.developmentMode && rawFilePath && fs.existsSync(rawFilePath)) {
        try {
            if (!fs.existsSync(savedRawDataDir)) {
                fs.mkdirSync(savedRawDataDir, { recursive: true });
            }

            const serviceName = (timetable?.service_name || 'unknown')
                .replace(/[<>:"/\\|?*]/g, '_')
                .replace(/\s+/g, '_');

            rawDestFilename = `raw_${serviceName}.json`;
            const rawDestPath = path.join(savedRawDataDir, rawDestFilename);
            fs.copyFileSync(rawFilePath, rawDestPath);
            console.log(`Step 2: Copied raw data to saved_raw_data/${rawDestFilename}`);
        } catch (err) {
            console.error('Error copying raw file (dev mode):', err.message);
        }
    } else if (!config.developmentMode) {
        console.log('Step 2: Skipped (not in dev mode)');
    }

    // ========================================
    // STEP 3: Save processed data to database
    // ========================================
    let dbSaveStats = {
        coordinateCount: 0,
        markerCount: 0,
        entriesUpdated: 0,
        errors: []
    };

    if (processedData && savedTimetableId) {
        try {
            console.log(`Step 3: Saving to database...`);

            // 3a. Save coordinates
            if (processedData.coordinates && Array.isArray(processedData.coordinates) && processedData.coordinates.length > 0) {
                dbSaveStats.coordinateCount = timetableCoordinateDb.insert(savedTimetableId, processedData.coordinates);
                console.log(`  - Saved ${dbSaveStats.coordinateCount} coordinates`);

                // Set coordinates_contributor from config
                if (config.contributorName) {
                    timetableDb.update(savedTimetableId, { coordinates_contributor: config.contributorName });
                    console.log(`  - Set coordinates_contributor: ${config.contributorName}`);
                }
            }

            // 3b. Save markers
            if (processedData.markers && Array.isArray(processedData.markers) && processedData.markers.length > 0) {
                dbSaveStats.markerCount = timetableMarkerDb.bulkInsert(savedTimetableId, processedData.markers);
                console.log(`  - Saved ${dbSaveStats.markerCount} markers`);
            }

            // 3c. Update timetable entries with coordinates
            if (processedData.timetable && Array.isArray(processedData.timetable)) {
                const dbEntries = entryDb.getByTimetableId(savedTimetableId);

                for (const processedEntry of processedData.timetable) {
                    if (processedEntry.latitude != null && processedEntry.longitude != null) {
                        // Handle special case: index 0 with empty location (WAIT FOR SERVICE)
                        if (processedEntry.index === 0 && (!processedEntry.location || processedEntry.location.trim() === '')) {
                            try {
                                entryDb.updateCoordinatesBySortOrderAndAction(
                                    savedTimetableId,
                                    0,
                                    'WAIT FOR SERVICE',
                                    processedEntry.latitude,
                                    processedEntry.longitude,
                                    processedEntry.apiName || ''
                                );
                                dbSaveStats.entriesUpdated++;
                                console.log(`  - Updated WAIT FOR SERVICE (index 0): ${processedEntry.latitude.toFixed(6)}, ${processedEntry.longitude.toFixed(6)}`);
                            } catch (updateErr) {
                                dbSaveStats.errors.push(`Failed to update WAIT FOR SERVICE: ${updateErr.message}`);
                            }
                            continue;
                        }

                        // Normal case: match by location name
                        if (processedEntry.location) {
                            const matchingDbEntry = dbEntries.find(dbEntry => {
                                const dbLocation = dbEntry.location || dbEntry.details || '';
                                return dbLocation === processedEntry.location;
                            });

                            if (matchingDbEntry) {
                                try {
                                    entryDb.updateCoordinatesByLocation(
                                        savedTimetableId,
                                        processedEntry.location,
                                        processedEntry.latitude,
                                        processedEntry.longitude,
                                        processedEntry.apiName || ''
                                    );
                                    dbSaveStats.entriesUpdated++;
                                    console.log(`  - Updated "${processedEntry.location}": ${processedEntry.latitude.toFixed(6)}, ${processedEntry.longitude.toFixed(6)}`);
                                } catch (updateErr) {
                                    dbSaveStats.errors.push(`Failed to update ${processedEntry.location}: ${updateErr.message}`);
                                }
                            } else {
                                console.log(`  - No DB match for "${processedEntry.location}"`);
                            }
                        }
                    }
                }
            }

            console.log(`Step 3 complete: ${dbSaveStats.coordinateCount} coords, ${dbSaveStats.markerCount} markers, ${dbSaveStats.entriesUpdated} entries updated`);
        } catch (err) {
            console.error('Error saving to database:', err.message);
            dbSaveStats.errors.push(err.message);
        }
    }

    // ========================================
    // STEP 4: Delete original raw file from recording_data
    // ========================================
    if (rawFilePath && fs.existsSync(rawFilePath)) {
        try {
            fs.unlinkSync(rawFilePath);
            console.log('Step 4: Deleted original raw file from recording_data');
        } catch (err) {
            console.error('Error deleting raw file:', err.message);
        }
    }

    // ========================================
    // STEP 5: Dev mode - export from database to processed_routes
    // Uses the same format as /api/timetables/:id/export/download
    // ========================================
    if (config.developmentMode && savedTimetableId) {
        try {
            if (!fs.existsSync(processedRoutesDir)) {
                fs.mkdirSync(processedRoutesDir, { recursive: true });
            }

            // Re-fetch all data from database to get the saved state
            const freshTimetable = timetableDb.getById(savedTimetableId);
            const freshEntries = entryDb.getByTimetableId(savedTimetableId);
            const freshCoordinates = timetableCoordinateDb.getByTimetableId(savedTimetableId);
            const freshMarkers = timetableMarkerDb.getByTimetableId(savedTimetableId);

            // Use the same export format as the timetable export page
            const exportData = buildTimetableExportJson({
                timetable: freshTimetable,
                entries: freshEntries,
                coordinates: freshCoordinates,
                markers: freshMarkers,
                savedTimetableCoords: null,
                includeCsvData: true,
                includeMarkerProcessing: true,
                completed: true
            });

            const serviceName = (freshTimetable?.service_name || 'unknown')
                .replace(/[<>:"/\\|?*]/g, '_')
                .replace(/\s+/g, '_');

            processedDestFilename = `processed_${serviceName}.json`;
            const processedDestPath = path.join(processedRoutesDir, processedDestFilename);
            fs.writeFileSync(processedDestPath, JSON.stringify(exportData, null, 2));
            console.log(`Step 5: Exported from DB to processed_routes/${processedDestFilename}`);
        } catch (err) {
            console.error('Error exporting processed file (dev mode):', err.message);
        }
    } else if (!config.developmentMode) {
        console.log('Step 5: Skipped (not in dev mode)');
    }

    // ========================================
    // STEP 6: Return success with all relevant data
    // ========================================
    const result = {
        success: true,
        message: 'Recording saved successfully',
        timetableId: savedTimetableId,
        routeId: routeId,
        serviceName: timetable?.service_name || 'Unknown',
        stats: {
            rawCoordinates: savedCoordCount,
            rawMarkers: savedMarkerCount,
            processedCoordinates: dbSaveStats.coordinateCount,
            processedMarkers: dbSaveStats.markerCount,
            timetableEntries: processedData?.timetable?.length || 0,
            entriesSavedToDb: dbSaveStats.entriesUpdated,
            detectedStops: processedData?.detectedStops || 0
        },
        developmentMode: config.developmentMode,
        files: config.developmentMode ? {
            rawFile: rawDestFilename,
            processedFile: processedDestFilename
        } : null
    };

    if (dbSaveStats.errors.length > 0) {
        result.warnings = dbSaveStats.errors;
    }

    console.log('\n========================================');
    console.log('Save process complete');
    console.log('========================================\n');

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
    lastTimetableTimeSeconds = null;
    currentGameTimeSeconds = null;
    currentSaveFrequency = SAVE_FREQUENCY;
    currentAutoStopTimeoutMs = AUTO_STOP_TIMEOUT_MS;

    // Clear auto-stop interval when resetting
    if (autoStopCheckInterval) {
        clearInterval(autoStopCheckInterval);
        autoStopCheckInterval = null;
    }

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

    // Restart auto-stop timer if in automatic mode
    if (autoStopEnabled) {
        lastUniqueCoordinateTime = Date.now();
        if (!autoStopCheckInterval) {
            autoStopCheckInterval = setInterval(checkAutoStop, 30000);
            console.log('Auto-stop interval started on resume (from pause)');
        }
    }

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

    // Build timetable data array
    // Priority: 1) savedTimetableCoords (from current recording session), 2) database coordinates
    const timetableData = processedEntries.map((entry, index) => {
        const savedCoords = savedTimetableCoords.get(index);
        // Find matching original entry to get database coordinates
        const originalEntry = entries.find(e =>
            (e.location === entry.location || e.details?.includes(entry.location))
        );
        const dbLat = originalEntry?.latitude ? parseFloat(originalEntry.latitude) : null;
        const dbLng = originalEntry?.longitude ? parseFloat(originalEntry.longitude) : null;

        const result = {
            index: entry.index,
            location: entry.location,
            arrival: entry.arrival || '',
            departure: entry.departure || '',
            platform: entry.platform || '',
            apiName: entry.apiName || '',
            latitude: savedCoords ? savedCoords.latitude : dbLat,
            longitude: savedCoords ? savedCoords.longitude : dbLng
        };

        // Include isPassThrough flag for GO VIA LOCATION entries
        if (entry.isPassThrough) {
            result.isPassThrough = true;
        }

        return result;
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

            // Get timetable entries to validate index and get location name
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
                location: processedEntries[index].location
            });
        } catch (err) {
            sendJson(res, { success: false, error: 'Invalid JSON data' }, 400);
        }
    });
}

/**
 * Process coordinate data from telemetry stream
 * Called by the stream controller when recording is active
 * @param {Object} geoLocation - {latitude, longitude}
 * @param {number} gradient - Current gradient
 * @param {number} height - Current height
 * @param {string} gameTimeISO - Current in-game time in ISO8601 format
 */
function processCoordinate(geoLocation, gradient, height, gameTimeISO) {
    if (!isRecording || isPaused) return;

    // Update current game time for auto-stop checking
    if (gameTimeISO) {
        currentGameTimeSeconds = isoTimeToSeconds(gameTimeISO);
    }

    if (!geoLocation || typeof geoLocation.latitude !== 'number' || typeof geoLocation.longitude !== 'number') {
        return;
    }

    // Skip TSW cached/stale position when game not active
    const lat = geoLocation.latitude;
    const lng = geoLocation.longitude;
    const isStalePosition = lat === 51.380108707397724 && lng === 0.5219243867730494;
    if (isStalePosition || (lat === 0 && lng === 0)) {
        return;
    }

    const coordinate = {
        longitude: geoLocation.longitude,
        latitude: geoLocation.latitude,
        timestamp: new Date().toISOString(),
        gameTime: gameTimeISO || null
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
        // Update last unique coordinate time for auto-stop tracking
        lastUniqueCoordinateTime = Date.now();

        routeCoordinates.push(coordinate);

        // Save to file periodically based on save frequency setting
        if (routeCoordinates.length % currentSaveFrequency === 0) {
            const timetable = timetableDb.getById(currentTimetableId);
            const entries = entryDb.getByTimetableId(currentTimetableId);
            saveRouteData(timetable, entries);
            if (currentSaveFrequency >= 100) {
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
 * @param {Object} timetable - Timetable object
 * @param {Array} entries - Timetable entries
 * @param {boolean} completed - Whether recording is complete (default: false)
 */
function saveRouteData(timetable, entries, completed = false) {
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
        includeMarkerProcessing: false,  // Recording markers already have their data
        completed: completed,  // Mark as incomplete during recording, complete on stop
        recordingMode: autoStopEnabled ? 'automatic' : 'manual'
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
        const result = {
            index: entry.index,
            location: entry.location,
            arrival: entry.arrival || '',
            departure: entry.departure || '',
            platform: entry.platform || '',
            apiName: entry.apiName || '',
            latitude: savedCoords ? savedCoords.latitude : null,
            longitude: savedCoords ? savedCoords.longitude : null
        };

        // Include isPassThrough flag for GO VIA LOCATION entries
        if (entry.isPassThrough) {
            result.isPassThrough = true;
        }

        return result;
    });

    // Check if auto-stop was triggered
    const wasAutoStopped = autoStopped;
    if (autoStopped) {
        // Reset the flag after reading (one-time notification)
        autoStopped = false;
    }

    return {
        isRecording,
        isPaused,
        timetableId: currentTimetableId,
        routeName: timetable ? timetable.service_name : 'Unknown',
        coordinateCount: routeCoordinates.length,
        markerCount: discoveredMarkers.length,
        timetable: timetableData,
        autoStopped: wasAutoStopped,
        autoStopEnabled: autoStopEnabled
    };
}

/**
 * Check for existing INCOMPLETE recording file for a timetable
 * Returns the most recent incomplete recording file if one exists
 * Only returns files where completed !== true
 */
function checkExistingRecording(req, res, timetableId) {
    if (!fs.existsSync(recordingDataDir)) {
        sendJson(res, { exists: false });
        return;
    }

    // Get the first JSON file in the folder (there will only ever be one)
    const files = fs.readdirSync(recordingDataDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
        sendJson(res, { exists: false });
        return;
    }

    const filename = files[0];
    const filePath = path.join(recordingDataDir, filename);

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip completed files
        if (data.completed === true) {
            sendJson(res, { exists: false });
            return;
        }

        // Found an incomplete file
        sendJson(res, {
            exists: true,
            filename: filename,
            routeName: data.routeName || 'Unknown',
            coordinateCount: data.coordinates ? data.coordinates.length : 0,
            markerCount: data.markers ? data.markers.length : 0,
            timetableEntryCount: data.timetable ? data.timetable.length : 0,
            completed: data.completed || false
        });
    } catch (err) {
        console.warn(`Could not parse file ${filename}:`, err.message);
        sendJson(res, { exists: false });
    }
}

/**
 * Check for any INCOMPLETE recording file in the recording_data folder
 * Returns the first JSON file found (there will only ever be one file)
 * Only returns files where completed !== true
 */
function checkAnyExistingRecording(req, res) {
    if (!fs.existsSync(recordingDataDir)) {
        sendJson(res, { exists: false });
        return;
    }

    // Get the first JSON file in the folder (there will only ever be one)
    const files = fs.readdirSync(recordingDataDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
        sendJson(res, { exists: false });
        return;
    }

    const filename = files[0];
    const filePath = path.join(recordingDataDir, filename);

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip completed files
        if (data.completed === true) {
            sendJson(res, { exists: false });
            return;
        }

        // Found an incomplete file
        sendJson(res, {
            exists: true,
            filename: filename,
            timetableId: data.timetableId || null,
            routeName: data.routeName || 'Unknown',
            serviceName: data.serviceName || 'Unknown',
            coordinateCount: data.coordinates ? data.coordinates.length : 0,
            markerCount: data.markers ? data.markers.length : 0,
            timetableEntryCount: data.timetable ? data.timetable.length : 0,
            completed: data.completed || false
        });
    } catch (err) {
        console.warn(`Could not parse file ${filename}:`, err.message);
        sendJson(res, { exists: false });
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

/**
 * Delete a raw recording file (called by frontend after DB save in normal mode)
 */
function deleteRawFile(req, res, filename) {
    if (!filename) {
        sendJson(res, { success: false, error: 'Filename is required' }, 400);
        return;
    }

    const filePath = path.join(recordingDataDir, filename);
    if (!fs.existsSync(filePath)) {
        // File already deleted or doesn't exist - that's ok
        sendJson(res, { success: true, message: 'File not found (may already be deleted)' });
        return;
    }

    try {
        fs.unlinkSync(filePath);
        console.log(`Deleted raw file: ${filename}`);
        sendJson(res, { success: true, message: 'File deleted' });
    } catch (err) {
        console.error('Error deleting raw file:', err.message);
        sendJson(res, { success: false, error: err.message }, 500);
    }
}

/**
 * Set recording mode (manual/automatic)
 * In automatic mode, recording will auto-stop after 2 minutes of no unique coordinates
 */
async function setMode(req, res) {
    try {
        const body = await parseBody(req);
        const mode = body.mode;

        if (mode !== 'manual' && mode !== 'automatic') {
            sendJson(res, { success: false, error: 'Invalid mode. Must be "manual" or "automatic"' }, 400);
            return;
        }

        const wasAutoStopEnabled = autoStopEnabled;
        autoStopEnabled = (mode === 'automatic');

        // Manage auto-stop interval
        if (autoStopEnabled && !autoStopCheckInterval) {
            // Start auto-stop checker (check every 30 seconds)
            autoStopCheckInterval = setInterval(checkAutoStop, 30000);
            // Initialize the timestamp if we're currently recording
            if (isRecording && !isPaused) {
                lastUniqueCoordinateTime = Date.now();
            }
            console.log('Auto-stop mode enabled');
        } else if (!autoStopEnabled && autoStopCheckInterval) {
            // Stop auto-stop checker
            clearInterval(autoStopCheckInterval);
            autoStopCheckInterval = null;
            console.log('Auto-stop mode disabled');
        }

        sendJson(res, {
            success: true,
            mode: mode,
            autoStopEnabled: autoStopEnabled,
            message: `Recording mode set to ${mode}`
        });
    } catch (err) {
        sendJson(res, { success: false, error: err.message }, 500);
    }
}

/**
 * Get current recording mode
 */
function getMode(req, res) {
    sendJson(res, {
        mode: autoStopEnabled ? 'automatic' : 'manual',
        autoStopEnabled: autoStopEnabled,
        autoStopTimeoutMs: currentAutoStopTimeoutMs
    });
}

/**
 * Check if auto-stop should trigger
 * Called periodically when auto-stop mode is enabled
 *
 * Auto-stop triggers when BOTH conditions are met:
 * 1. In-game time is past the last timetable time (arrival at final stop)
 * 2. No unique coordinates received for 2 minutes (train stationary)
 */
function checkAutoStop() {
    // Format times for logging
    const formatTime = (secs) => {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    // Check if game time has passed the last timetable time
    let pastLastTimetableTime = false;
    let gameTimeStatus = 'unknown';

    if (lastTimetableTimeSeconds !== null && currentGameTimeSeconds !== null) {
        pastLastTimetableTime = currentGameTimeSeconds >= lastTimetableTimeSeconds;
        gameTimeStatus = `gameTime=${formatTime(currentGameTimeSeconds)}, lastTimetable=${formatTime(lastTimetableTimeSeconds)}, pastLast=${pastLastTimetableTime}`;
    } else if (lastTimetableTimeSeconds === null) {
        // No timetable time found, only use inactivity
        pastLastTimetableTime = true;
        gameTimeStatus = 'no timetable time (using inactivity only)';
    } else {
        gameTimeStatus = 'waiting for game time';
    }

    // Only count inactivity once we've reached the last timetable time
    let inactivityElapsed = 0;
    let hasInactivity = false;

    if (pastLastTimetableTime && lastUniqueCoordinateTime) {
        inactivityElapsed = Math.round((Date.now() - lastUniqueCoordinateTime) / 1000);
        hasInactivity = (Date.now() - lastUniqueCoordinateTime > currentAutoStopTimeoutMs);
    }

    const inactivityStatus = pastLastTimetableTime ? `inactivity=${inactivityElapsed}s` : 'inactivity=waiting for last timetable time';
    console.log(`Auto-stop check: enabled=${autoStopEnabled}, recording=${isRecording}, paused=${isPaused}, ${inactivityStatus}, ${gameTimeStatus}`);

    if (!autoStopEnabled || !isRecording || isPaused) {
        return;
    }

    // Both conditions must be true
    if (hasInactivity && pastLastTimetableTime) {
        console.log('Auto-stop triggered: train stationary for 2 min AND game time past last timetable time');
        triggerAutoStop();
    }
}

/**
 * Trigger auto-stop - sets flag so frontend knows to call stop()
 * Frontend will call the stop endpoint when it sees this flag
 */
function triggerAutoStop() {
    autoStopped = true;
    // The flag is picked up by getRecordingStateForStream() and sent to the frontend.
    // Frontend then calls the stop endpoint which handles all processing and DB save.
    console.log('Auto-stop flag set - frontend will call stop endpoint');
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
    loadRecordingFile,
    deleteRawFile,
    setMode,
    getMode
};
