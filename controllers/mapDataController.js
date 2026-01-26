'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson, parseBody } = require('../utils/http');
const { timetableDb, timetableDataDb, timetableCoordinateDb, timetableMarkerDb, entryDb } = require('../db');
const { processRawData } = require('./routeProcessingController');
const { loadConfig } = require('./configController');

/**
 * Get all timetables with coordinate counts (for selection dropdown)
 */
function getAllTimetables(req, res) {
    const timetables = timetableDataDb.getAllWithCounts();

    // Add hasCoordinates flag
    const timetablesWithInfo = timetables.map(tt => ({
        ...tt,
        hasCoordinates: tt.coordinate_count > 0
    }));

    sendJson(res, timetablesWithInfo);
}

/**
 * Get timetables that have coordinate data
 */
function getTimetablesWithData(req, res) {
    const timetables = timetableDataDb.getTimetablesWithCoordinates();
    sendJson(res, timetables);
}

/**
 * Get full timetable data (coordinates, markers, entries) for map display
 */
function getTimetableData(req, res, timetableId) {
    const timetableData = timetableDataDb.getFullTimetableData(timetableId);

    if (!timetableData) {
        sendJson(res, { error: 'Timetable not found' }, 404);
        return;
    }

    sendJson(res, timetableData);
}

/**
 * Import recording data into a timetable
 */
async function importFromRecording(req, res) {
    let body = '';

    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', () => {
        try {
            const { timetableId, recordingData } = JSON.parse(body);

            if (!timetableId) {
                sendJson(res, { error: 'timetableId is required' }, 400);
                return;
            }

            // Validate timetable exists
            const timetable = timetableDb.getById(timetableId);
            if (!timetable) {
                sendJson(res, { error: 'Timetable not found' }, 404);
                return;
            }

            let coordinateCount = 0;
            let markerCount = 0;

            // Import coordinates
            if (recordingData.coordinates && Array.isArray(recordingData.coordinates)) {
                coordinateCount = timetableCoordinateDb.insert(timetableId, recordingData.coordinates);

                // Set coordinates_contributor from config
                const config = loadConfig();
                if (config.contributorName) {
                    timetableDb.update(timetableId, { coordinates_contributor: config.contributorName });
                }
            }

            // Import markers
            if (recordingData.markers && Array.isArray(recordingData.markers)) {
                markerCount = timetableMarkerDb.bulkInsert(timetableId, recordingData.markers);
            }

            sendJson(res, {
                success: true,
                timetableId,
                serviceName: timetable.service_name,
                coordinateCount,
                markerCount
            });
        } catch (err) {
            sendJson(res, { error: 'Invalid JSON data: ' + err.message }, 400);
        }
    });
}

/**
 * Save processed JSON data to the database
 * - Always processes raw file on-the-fly (unified flow for both dev and non-dev modes)
 * - Coordinates -> timetable_coordinates (as JSON string)
 * - Markers -> timetable_markers
 * - Timetable entries -> update lat/lng in timetable_entries by matching location field
 * - In dev mode: writes the processed file to disk at the end
 */
async function saveProcessedJson(req, res) {
    try {
        const body = await parseBody(req);
        const { filename } = body;

        if (!filename) {
            sendJson(res, { error: 'filename is required' }, 400);
            return;
        }

        // Prepare paths
        const processedRoutesDir = path.join(__dirname, '..', 'processed_routes');
        const recordingDataDir = path.join(__dirname, '..', 'recording_data');
        const rawFilename = filename.replace('processed_', 'raw_data_');
        const rawFilePath = path.join(recordingDataDir, rawFilename);
        const processedFilePath = path.join(processedRoutesDir, filename);

        let processedData;

        // Always process from raw file (unified flow for both modes)
        if (fs.existsSync(rawFilePath)) {
            console.log(`Processing raw file on-the-fly: ${rawFilename}`);
            const rawContent = fs.readFileSync(rawFilePath, 'utf8');
            const rawData = JSON.parse(rawContent);
            processedData = processRawData(rawData);
        } else {
            // Raw file doesn't exist
            sendJson(res, { error: `Raw file not found: ${rawFilename}` }, 404);
            return;
        }

        const timetableId = processedData.timetableId;
        if (!timetableId) {
            sendJson(res, { error: 'timetableId not found in JSON' }, 400);
            return;
        }

        // Validate timetable exists
        const timetable = timetableDb.getById(timetableId);
        if (!timetable) {
            sendJson(res, { error: `Timetable ${timetableId} not found in database` }, 404);
            return;
        }

        let coordinateCount = 0;
        let markerCount = 0;
        let entryUpdates = 0;

        // 1. Save coordinates as JSON string
        if (processedData.coordinates && Array.isArray(processedData.coordinates)) {
            coordinateCount = timetableCoordinateDb.insert(timetableId, processedData.coordinates);
            console.log(`Saved ${coordinateCount} coordinates for timetable ${timetableId}`);

            // Set coordinates_contributor from config
            const contributorConfig = loadConfig();
            if (contributorConfig.contributorName) {
                timetableDb.update(timetableId, { coordinates_contributor: contributorConfig.contributorName });
                console.log(`Set coordinates_contributor: ${contributorConfig.contributorName}`);
            }
        }

        // 2. Save markers
        if (processedData.markers && Array.isArray(processedData.markers)) {
            markerCount = timetableMarkerDb.bulkInsert(timetableId, processedData.markers);
            console.log(`Saved ${markerCount} markers for timetable ${timetableId}`);
        }

        // 3. Update timetable entries with lat/lng and apiName from timetable array
        // Match json.timetable[].location to timetable_entries.location
        // Special case: index 0 with empty location - update WAIT FOR SERVICE at sort_order 0
        console.log(`\n=== SAVING TIMETABLE ENTRIES ===`);
        console.log(`Total entries in processed data: ${processedData.timetable?.length || 0}`);
        if (processedData.timetable && Array.isArray(processedData.timetable)) {
            for (const entry of processedData.timetable) {
                const hasCoords = entry.latitude && entry.longitude;
                console.log(`  [${entry.index}] "${entry.location}": ${hasCoords ? `${entry.latitude.toFixed(6)}, ${entry.longitude.toFixed(6)}` : 'NO COORDS'}`);
                if (hasCoords) {
                    if (entry.location) {
                        // Normal case: match by location
                        entryDb.updateCoordinatesByLocation(
                            timetableId,
                            entry.location,
                            entry.latitude,
                            entry.longitude,
                            entry.apiName || ''
                        );
                        entryUpdates++;
                        console.log(`    -> Updated entry for location "${entry.location}"`);
                    } else if (entry.index === 0) {
                        // Special case: first entry with empty location
                        // Update the WAIT FOR SERVICE entry at sort_order 0
                        entryDb.updateCoordinatesBySortOrderAndAction(
                            timetableId,
                            0,
                            'WAIT FOR SERVICE',
                            entry.latitude,
                            entry.longitude,
                            entry.apiName || ''
                        );
                        entryUpdates++;
                        console.log(`Updated WAIT FOR SERVICE entry (index 0) with lat=${entry.latitude}, lng=${entry.longitude}, apiName=${entry.apiName}`);
                    }
                }
            }
        }

        // In development mode, write the processed file to disk at the end
        const config = loadConfig();
        let savedProcessedFile = false;
        if (config.developmentMode) {
            if (!fs.existsSync(processedRoutesDir)) {
                fs.mkdirSync(processedRoutesDir, { recursive: true });
            }
            fs.writeFileSync(processedFilePath, JSON.stringify(processedData, null, 2));
            savedProcessedFile = true;
            console.log(`Dev mode: Saved processed file: ${filename}`);
        }

        sendJson(res, {
            success: true,
            timetableId,
            serviceName: timetable.service_name,
            coordinateCount,
            markerCount,
            entryUpdates,
            filename,
            savedProcessedFile
        });

    } catch (err) {
        console.error('Error saving processed JSON:', err);
        sendJson(res, { error: 'Failed to save: ' + err.message }, 500);
    }
}

/**
 * Get route data from database for live map display (no file creation)
 * Returns the same structure as remakeProcessedJson but directly as JSON response
 */
async function getRouteDataFromDb(req, res, timetableId) {
    try {
        if (!timetableId) {
            sendJson(res, { error: 'timetableId is required' }, 400);
            return;
        }

        // Get timetable info
        const timetable = timetableDb.getById(timetableId);
        if (!timetable) {
            sendJson(res, { error: `Timetable ${timetableId} not found` }, 404);
            return;
        }

        // Get coordinates from timetable_coordinates
        const rawCoordinates = timetableCoordinateDb.getByTimetableId(timetableId);

        // Filter out stale Chatham position (game default when no real position)
        const coordinates = rawCoordinates.filter(c =>
            !(c.latitude === 51.380108707397724 && c.longitude === 0.5219243867730494)
        );

        // Get markers from timetable_markers
        const markers = timetableMarkerDb.getByTimetableId(timetableId);

        // Get entries from timetable_entries
        const entries = entryDb.getByTimetableId(timetableId);

        // Build timetable array from entries (include entries with a location, even without coordinates)
        const timetableArray = [];
        let entryIndex = 0;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];

            // Only include entries that have a location
            if (!entry.location || entry.location.trim() === '') {
                continue;
            }

            let arrival = '';
            let departure = '';

            // GO VIA LOCATION entries have no times - train passes through without stopping
            if (entry.action !== 'GO VIA LOCATION') {
                if (entry.action === 'WAIT FOR SERVICE') {
                    arrival = entry.time2 || '';
                } else {
                    arrival = entry.time1 || '';
                }

                if (i + 1 < entries.length) {
                    departure = entries[i + 1].time1 || '';
                }
            }

            const timetableEntry = {
                id: entry.id,  // Database ID for SAVE LOC functionality
                index: entryIndex,
                location: entry.location,
                arrival: arrival,
                departure: departure,
                platform: entry.platform || '',
                apiName: entry.api_name || ''
            };

            // Only include coordinates if they exist
            if (entry.latitude && entry.longitude && entry.latitude !== '' && entry.longitude !== '') {
                timetableEntry.latitude = parseFloat(entry.latitude);
                timetableEntry.longitude = parseFloat(entry.longitude);
            }

            // Include isPassThrough flag for GO VIA LOCATION entries
            if (entry.action === 'GO VIA LOCATION') {
                timetableEntry.isPassThrough = true;
            }

            timetableArray.push(timetableEntry);
            entryIndex++;
        }

        // Build the route data structure
        const routeData = {
            routeName: timetable.service_name,
            timetableId: timetableId,
            totalPoints: coordinates.length,
            coordinates: coordinates,
            markers: markers.map(m => ({
                stationName: m.station_name,
                markerType: m.marker_type,
                platformLength: m.platform_length,
                latitude: m.latitude,
                longitude: m.longitude
            })),
            timetable: timetableArray
        };

        sendJson(res, routeData);

    } catch (err) {
        console.error('Error getting route data from DB:', err);
        sendJson(res, { error: 'Failed to get route data: ' + err.message }, 500);
    }
}

/**
 * Remake processed JSON from database data only
 * Creates a JSON file in the 'exported_routes' folder using data from:
 * - timetables table (service_name)
 * - timetable_coordinates table (coordinates JSON)
 * - timetable_markers table (markers)
 * - timetable_entries table (timetable entries with lat/lng/apiName)
 */
async function remakeProcessedJson(req, res) {
    try {
        const body = await parseBody(req);
        const { timetableId } = body;

        if (!timetableId) {
            sendJson(res, { error: 'timetableId is required' }, 400);
            return;
        }

        // Get timetable info
        const timetable = timetableDb.getById(timetableId);
        if (!timetable) {
            sendJson(res, { error: `Timetable ${timetableId} not found` }, 404);
            return;
        }

        // Get coordinates from timetable_coordinates
        const rawCoordinates = timetableCoordinateDb.getByTimetableId(timetableId);

        // Filter out stale Chatham position (game default when no real position)
        const coordinates = rawCoordinates.filter(c =>
            !(c.latitude === 51.380108707397724 && c.longitude === 0.5219243867730494)
        );

        // Get markers from timetable_markers
        const markers = timetableMarkerDb.getByTimetableId(timetableId);

        // Get entries from timetable_entries
        const entries = entryDb.getByTimetableId(timetableId);

        // Build timetable array from entries (include entries with a location, even without coordinates)
        // - WAIT FOR SERVICE (sort_order 0): arrival = time2, departure = next sort_order's time1
        // - STOP AT LOCATION: arrival = time1, departure = next sort_order's time1
        const timetableArray = [];
        let entryIndex = 0;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];

            // Only include entries that have a location
            if (!entry.location || entry.location.trim() === '') {
                continue;
            }

            let arrival = '';
            let departure = '';

            // GO VIA LOCATION entries have no times - train passes through without stopping
            if (entry.action !== 'GO VIA LOCATION') {
                if (entry.action === 'WAIT FOR SERVICE') {
                    // First entry: arrival is time2 (scheduled start), departure is next entry's time1
                    arrival = entry.time2 || '';
                } else {
                    // Other entries: arrival is time1
                    arrival = entry.time1 || '';
                }

                // Departure is always the next entry's time1 (if exists)
                if (i + 1 < entries.length) {
                    departure = entries[i + 1].time1 || '';
                }
            }

            const timetableEntry = {
                id: entry.id,  // Database ID for SAVE LOC functionality
                index: entryIndex,
                location: entry.location,
                arrival: arrival,
                departure: departure,
                platform: entry.platform || '',
                apiName: entry.api_name || ''
            };

            // Only include coordinates if they exist
            if (entry.latitude && entry.longitude && entry.latitude !== '' && entry.longitude !== '') {
                timetableEntry.latitude = parseFloat(entry.latitude);
                timetableEntry.longitude = parseFloat(entry.longitude);
            }

            // Include isPassThrough flag for GO VIA LOCATION entries
            if (entry.action === 'GO VIA LOCATION') {
                timetableEntry.isPassThrough = true;
            }

            timetableArray.push(timetableEntry);
            entryIndex++;
        }

        // Build the exported JSON structure
        const exportedJson = {
            routeName: timetable.service_name,
            timetableId: timetableId,
            totalPoints: coordinates.length,
            coordinates: coordinates,
            markers: markers.map(m => ({
                stationName: m.station_name,
                markerType: m.marker_type,
                platformLength: m.platform_length,
                latitude: m.latitude,
                longitude: m.longitude
            })),
            timetable: timetableArray
        };

        // Ensure output folder exists
        const exportDir = path.join(__dirname, '..', 'Remake JSON from DB');
        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true });
        }

        // Create filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `exported_timetable_${timetableId}_${timestamp}.json`;
        const filePath = path.join(exportDir, filename);

        // Write the file
        fs.writeFileSync(filePath, JSON.stringify(exportedJson, null, 2));

        console.log(`Created exported JSON: ${filename}`);
        console.log(`  - Coordinates: ${coordinates.length}`);
        console.log(`  - Markers: ${markers.length}`);
        console.log(`  - Timetable entries: ${timetableArray.length}`);

        sendJson(res, {
            success: true,
            filename,
            timetableId,
            serviceName: timetable.service_name,
            stats: {
                coordinates: coordinates.length,
                markers: markers.length,
                timetableEntries: timetableArray.length
            }
        });

    } catch (err) {
        console.error('Error remaking processed JSON:', err);
        sendJson(res, { error: 'Failed to remake: ' + err.message }, 500);
    }
}

module.exports = {
    getAllTimetables,
    getTimetablesWithData,
    getTimetableData,
    importFromRecording,
    saveProcessedJson,
    getRouteDataFromDb,
    remakeProcessedJson
};
