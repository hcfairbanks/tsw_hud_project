'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson, parseBody } = require('../utils/http');
const { timetableDb, timetableDataDb, timetableCoordinateDb, timetableMarkerDb, entryDb } = require('../db');

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
 * - Coordinates -> timetable_coordinates (as JSON string)
 * - Markers -> timetable_markers
 * - Timetable entries -> update lat/lng in timetable_entries by matching destination to location
 */
async function saveProcessedJson(req, res) {
    try {
        const body = await parseBody(req);
        const { filename } = body;

        if (!filename) {
            sendJson(res, { error: 'filename is required' }, 400);
            return;
        }

        // Construct path to processed_routes folder
        const processedRoutesDir = path.join(__dirname, '..', 'processed_routes');
        const filePath = path.join(processedRoutesDir, filename);

        // Check if file exists
        if (!fs.existsSync(filePath)) {
            sendJson(res, { error: `File not found: ${filename}` }, 404);
            return;
        }

        // Read and parse JSON
        const jsonContent = fs.readFileSync(filePath, 'utf8');
        const processedData = JSON.parse(jsonContent);

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
        }

        // 2. Save markers
        if (processedData.markers && Array.isArray(processedData.markers)) {
            markerCount = timetableMarkerDb.bulkInsert(timetableId, processedData.markers);
            console.log(`Saved ${markerCount} markers for timetable ${timetableId}`);
        }

        // 3. Update timetable entries with lat/lng and apiName from timetable array
        // Match json.timetable[].destination to timetable_entries.location
        // Special case: index 0 with empty destination - update WAIT FOR SERVICE at sort_order 0
        if (processedData.timetable && Array.isArray(processedData.timetable)) {
            for (const entry of processedData.timetable) {
                if (entry.latitude && entry.longitude) {
                    if (entry.destination) {
                        // Normal case: match by destination/location
                        entryDb.updateCoordinatesByLocation(
                            timetableId,
                            entry.destination,
                            entry.latitude,
                            entry.longitude,
                            entry.apiName || ''
                        );
                        entryUpdates++;
                        console.log(`Updated entry for location "${entry.destination}" with lat=${entry.latitude}, lng=${entry.longitude}, apiName=${entry.apiName}`);
                    } else if (entry.index === 0) {
                        // Special case: first entry with empty destination
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

        sendJson(res, {
            success: true,
            timetableId,
            serviceName: timetable.service_name,
            coordinateCount,
            markerCount,
            entryUpdates,
            filename
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
        const coordinates = timetableCoordinateDb.getByTimetableId(timetableId);

        // Get markers from timetable_markers
        const markers = timetableMarkerDb.getByTimetableId(timetableId);

        // Get entries from timetable_entries
        const entries = entryDb.getByTimetableId(timetableId);

        // Build timetable array from entries
        const timetableArray = [];
        let entryIndex = 0;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.latitude && entry.longitude && entry.latitude !== '' && entry.longitude !== '') {
                let arrival = '';
                let departure = '';

                if (entry.action === 'WAIT FOR SERVICE') {
                    arrival = entry.time2 || '';
                } else {
                    arrival = entry.time1 || '';
                }

                if (i + 1 < entries.length) {
                    departure = entries[i + 1].time1 || '';
                }

                timetableArray.push({
                    index: entryIndex,
                    destination: entry.location || '',
                    arrival: arrival,
                    departure: departure,
                    platform: entry.platform || '',
                    apiName: entry.api_name || '',
                    latitude: parseFloat(entry.latitude),
                    longitude: parseFloat(entry.longitude)
                });
                entryIndex++;
            }
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
 * Creates a final JSON file in the 'final' folder using data from:
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
        const coordinates = timetableCoordinateDb.getByTimetableId(timetableId);

        // Get markers from timetable_markers
        const markers = timetableMarkerDb.getByTimetableId(timetableId);

        // Get entries from timetable_entries
        const entries = entryDb.getByTimetableId(timetableId);

        // Build timetable array from entries
        // For each entry with coordinates, we need to find the arrival and departure times
        // - WAIT FOR SERVICE (sort_order 0): arrival = time2, departure = next sort_order's time1
        // - STOP AT LOCATION: arrival = time1, departure = next sort_order's time1
        const timetableArray = [];
        let entryIndex = 0;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            // Only include entries that have coordinates (location-based stops)
            if (entry.latitude && entry.longitude && entry.latitude !== '' && entry.longitude !== '') {
                let arrival = '';
                let departure = '';

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

                timetableArray.push({
                    index: entryIndex,
                    destination: entry.location || '',
                    arrival: arrival,
                    departure: departure,
                    platform: entry.platform || '',
                    apiName: entry.api_name || '',
                    latitude: parseFloat(entry.latitude),
                    longitude: parseFloat(entry.longitude)
                });
                entryIndex++;
            }
        }

        // Build the final JSON structure
        const finalJson = {
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

        // Ensure final folder exists
        const finalDir = path.join(__dirname, '..', 'final');
        if (!fs.existsSync(finalDir)) {
            fs.mkdirSync(finalDir, { recursive: true });
        }

        // Create filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `final_timetable_${timetableId}_${timestamp}.json`;
        const filePath = path.join(finalDir, filename);

        // Write the file
        fs.writeFileSync(filePath, JSON.stringify(finalJson, null, 2));

        console.log(`Created final JSON: ${filename}`);
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
