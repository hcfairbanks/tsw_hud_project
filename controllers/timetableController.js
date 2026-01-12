'use strict';
const fs = require('fs');
const path = require('path');
const { timetableDb, entryDb, timetableCoordinateDb, timetableMarkerDb, routeDb, trainDb, stationMappingDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');
const { preprocessTimetableEntries, calculateMarkerPositions, mapTimetableToMarkers } = require('./processingController');

// Get the directory where the app is running from
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const OUTPUT_UNPROCESSED_DIR = path.join(appDir, 'unprocessed_routes');

/**
 * Write timetable data to a JSON file in unprocessed_routes folder
 * Logic copied from ThirdRails export in show.html, with added fields:
 * - index: row number
 * - apiName: Destination + " Platform " + Platform
 * - longitude/latitude: null for now
 *
 * @param {Array} entries - Raw timetable entries from database
 * @param {string} serviceName - The service/route name
 * @param {number} routeId - Optional route ID for station name mapping
 * @param {number} timetableId - The timetable ID
 * @returns {string|null} The output file path, or null if failed
 */
function writeToJSONRouteSkeleton(entries, serviceName, routeId, timetableId) {
    try {
        // Ensure output directory exists
        if (!fs.existsSync(OUTPUT_UNPROCESSED_DIR)) {
            fs.mkdirSync(OUTPUT_UNPROCESSED_DIR, { recursive: true });
        }

        // Generate filename
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10) + '_' + now.toTimeString().slice(0, 8).replace(/:/g, '-');
        const filename = `raw_data_timetable_${timetableId}_${dateStr}.json`;
        const outputFile = path.join(OUTPUT_UNPROCESSED_DIR, filename);

        // Load station name mapping from database
        let stationMappings = {};
        if (routeId) {
            stationMappings = stationMappingDb.getMappingObject(routeId);
        } else {
            stationMappings = stationMappingDb.getMappingObject(null);
        }

        // Build timetable - copied from ThirdRails export logic in show.html
        // Combine STOP/WAIT entries with following LOAD PASSENGERS
        const timetable = [];
        let index = 0;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const action = (entry.action || '').toUpperCase().trim();

            if (action === 'WAIT FOR SERVICE') {
                const destination = entry.location || '';
                const platform = entry.platform || '';
                // WAIT FOR SERVICE: arrival is time2
                const arrival = entry.time2 || '';
                let departure = '';

                // Look for following LOAD PASSENGERS to get departure time
                if (i + 1 < entries.length) {
                    const nextEntry = entries[i + 1];
                    if ((nextEntry.action || '').toUpperCase().trim() === 'LOAD PASSENGERS') {
                        departure = nextEntry.time1 || '';
                        i++; // Skip the LOAD PASSENGERS entry
                    } else {
                        // No LOAD PASSENGERS after: departure = time2 (same as arrival)
                        departure = arrival;
                    }
                } else {
                    // No next entry: departure = time2 (same as arrival)
                    departure = arrival;
                }

                // Build apiName: mapped destination + " Platform " + platform
                const mappedDestination = stationMappings[destination] || destination;
                const apiName = (mappedDestination && platform) ? mappedDestination + ' ' + platform : '';

                timetable.push({
                    index: index++,
                    destination: destination,
                    arrival: arrival,
                    departure: departure,
                    platform: platform,
                    apiName: apiName,
                    longitude: null,
                    latitude: null
                });
            } else if (action === 'STOP AT LOCATION') {
                const destination = entry.location || '';
                const platform = entry.platform || '';
                // STOP AT LOCATION: arrival is time1
                const arrival = entry.time1 || '';
                let departure = '';

                // Look for following LOAD PASSENGERS to get departure time
                if (i + 1 < entries.length) {
                    const nextEntry = entries[i + 1];
                    if ((nextEntry.action || '').toUpperCase().trim() === 'LOAD PASSENGERS') {
                        departure = nextEntry.time1 || '';
                        i++; // Skip the LOAD PASSENGERS entry
                    }
                }

                // Build apiName: mapped destination + " Platform " + platform
                const mappedDestination = stationMappings[destination] || destination;
                const apiName = (mappedDestination && platform) ? mappedDestination + ' ' + platform : '';

                timetable.push({
                    index: index++,
                    destination: destination,
                    arrival: arrival,
                    departure: departure,
                    platform: platform,
                    apiName: apiName,
                    longitude: null,
                    latitude: null
                });
            } else if (action === 'UNLOAD PASSENGERS') {
                // UNLOAD PASSENGERS with location = final stop
                const destination = entry.location || '';
                if (destination && destination !== '-') {
                    const platform = entry.platform || '';
                    const arrival = entry.time1 || '';
                    const mappedDestination = stationMappings[destination] || destination;
                    const apiName = (mappedDestination && platform) ? mappedDestination + ' ' + platform : '';

                    timetable.push({
                        index: index++,
                        destination: destination,
                        arrival: arrival,
                        departure: '',
                        platform: platform,
                        apiName: apiName,
                        longitude: null,
                        latitude: null
                    });
                }
            }
            // LOAD PASSENGERS alone is skipped - handled above with WAIT/STOP
        }

        // Create the route skeleton JSON
        const routeSkeleton = {
            routeName: serviceName || 'Unknown Route',
            totalPoints: 0,
            totalMarkers: 0,
            duration: 0,
            requestCount: 0,
            coordinates: [],
            markers: [],
            timetable: timetable
        };

        // Write the JSON file
        fs.writeFileSync(outputFile, JSON.stringify(routeSkeleton, null, 2));
        console.log(`Route skeleton JSON created: ${outputFile}`);

        return outputFile;
    } catch (err) {
        console.error('Error writing route skeleton JSON:', err);
        return null;
    }
}

const timetableController = {
    // GET /api/timetables
    // Supports query params: route_id, train_id
    getAll: async (req, res, routeId = null, trainId = null) => {
        let timetables = timetableDb.getAll();

        // Filter by route_id if provided
        if (routeId) {
            timetables = timetables.filter(t => t.route_id === routeId);
        }

        // Filter by train_id if provided
        if (trainId) {
            timetables = timetables.filter(t => t.train_id === trainId);
        }

        // Add coordinate counts
        const timetablesWithCounts = timetables.map(t => ({
            ...t,
            coordinate_count: timetableCoordinateDb.getCount(t.id)
        }));

        sendJson(res, timetablesWithCounts);
    },

    // POST /api/timetables
    create: async (req, res) => {
        const body = await parseBody(req);
        console.log('=== CREATE TIMETABLE ===');
        console.log('Body received:', JSON.stringify(body, null, 2));

        // Step 1: Create the timetable
        const serviceName = body.service_name || 'Untitled';
        const routeId = body.route_id || null;
        const trainId = body.train_id || null;
        const result = timetableDb.create(serviceName, routeId, trainId);
        const timetableId = result.lastInsertRowid;
        console.log('Timetable created with ID:', timetableId, 'route_id:', routeId, 'train_id:', trainId);

        // Step 2: Deduplicate entries based on unique time values
        // An entry is considered duplicate if it has the same action and time1/time2 combination
        let entries = body.entries || [];
        if (entries.length > 0) {
            const seenTimes = new Set();
            const uniqueEntries = [];

            for (const entry of entries) {
                // Create a unique key based on action + time1 + time2
                const time1 = (entry.time1 || '').trim();
                const time2 = (entry.time2 || '').trim();
                const action = (entry.action || '').trim();

                // Use the relevant time field(s) as the unique key
                // For most entries, time1 is the primary time
                const timeKey = `${action}|${time1}|${time2}`;

                if (!seenTimes.has(timeKey)) {
                    seenTimes.add(timeKey);
                    uniqueEntries.push(entry);
                } else {
                    console.log(`Skipping duplicate entry: ${action} at ${time1 || time2}`);
                }
            }

            console.log(`Deduplicated entries: ${entries.length} -> ${uniqueEntries.length}`);
            entries = uniqueEntries;
        }

        // Step 3: Create all entries
        const savedEntries = [];
        if (entries.length > 0) {
            console.log(`Creating ${entries.length} entries...`);
            entries.forEach((entry, index) => {
                const entryResult = entryDb.create(timetableId, entry, index);
                console.log(`Entry ${index + 1} created with ID: ${entryResult.lastInsertRowid}, timetable_id: ${timetableId}`);
                savedEntries.push({
                    id: entryResult.lastInsertRowid,
                    timetable_id: timetableId,
                    action: entry.action || '',
                    details: entry.details || '',
                    location: entry.location || '',
                    platform: entry.platform || '',
                    time1: entry.time1 || '',
                    time2: entry.time2 || '',
                    latitude: entry.latitude || '',
                    longitude: entry.longitude || '',
                    sort_order: index
                });
            });
        }

        // Step 4: Generate JSON file in unprocessed_routes folder
        // Uses identical logic to extract.js writeToJSONRouteSkeleton
        let jsonFilePath = null;
        if (entries.length > 0) {
            jsonFilePath = writeToJSONRouteSkeleton(entries, serviceName, routeId, timetableId);
            if (jsonFilePath) {
                console.log(`JSON skeleton file created: ${jsonFilePath}`);
            }
        }

        console.log('=== TIMETABLE CREATION COMPLETE ===');
        sendJson(res, {
            id: timetableId,
            service_name: serviceName,
            route_id: routeId,
            train_id: trainId,
            entries: savedEntries,
            json_file: jsonFilePath
        }, 201);
    },

    // GET /api/timetables/:id
    getById: async (req, res, id) => {
        const timetable = timetableDb.getById(id);
        if (timetable) {
            timetable.entries = entryDb.getByTimetableId(id);
            sendJson(res, timetable);
        } else {
            sendJson(res, { error: 'Timetable not found' }, 404);
        }
    },

    // PUT /api/timetables/:id
    update: async (req, res, id) => {
        const body = await parseBody(req);
        console.log('=== SAVE: Updating timetable ===');
        console.log('Timetable ID:', id);
        console.log('Body received:', JSON.stringify(body, null, 2));
        timetableDb.update(id, body.service_name);
        sendJson(res, { id, service_name: body.service_name });
    },

    // DELETE /api/timetables/:id
    delete: async (req, res, id) => {
        timetableDb.delete(id);
        sendJson(res, { success: true });
    },

    // GET /api/timetables/:id/export
    // Export timetable in the format expected by the frontend map
    export: async (req, res, id) => {
        const timetable = timetableDb.getById(id);
        if (!timetable) {
            sendJson(res, { error: 'Timetable not found' }, 404);
            return;
        }

        // Get related data
        const entries = entryDb.getByTimetableId(id);
        const coordinates = timetableCoordinateDb.getByTimetableId(id);
        const markers = timetableMarkerDb.getByTimetableId(id);

        // Get route and train names
        let routeName = null;
        let trainName = null;
        if (timetable.route_id) {
            const route = routeDb.getById(timetable.route_id);
            routeName = route ? route.name : null;
        }
        if (timetable.train_id) {
            const train = trainDb.getById(timetable.train_id);
            trainName = train ? train.name : null;
        }

        // Load station name mapping from database
        let stationNameMapping = {};
        if (timetable.route_id) {
            stationNameMapping = stationMappingDb.getMappingObject(timetable.route_id);
        } else {
            stationNameMapping = stationMappingDb.getMappingObject(null);
        }

        // Pre-process raw timetable entries into proper station entries
        // This combines WAIT FOR SERVICE + LOAD PASSENGERS, STOP + LOAD PASSENGERS, etc.
        const timetableEntries = preprocessTimetableEntries(entries, stationNameMapping);

        // Preserve any user-entered coordinates from original entries
        // Only match if destination is not empty to avoid false matches
        for (const entry of timetableEntries) {
            if (!entry.destination || !entry.destination.trim()) {
                continue; // Skip entries with empty destination
            }
            const originalEntry = entries.find(e =>
                (e.location || e.details) === entry.destination &&
                e.latitude && e.longitude
            );
            if (originalEntry) {
                entry.latitude = parseFloat(originalEntry.latitude);
                entry.longitude = parseFloat(originalEntry.longitude);
            }
        }

        // Calculate marker positions if we have coordinates
        if (coordinates.length > 0) {
            calculateMarkerPositions(markers, coordinates);
        }

        // Map timetable entries to marker coordinates (EXACT apiName matching only)
        const processedMarkers = markers.map(m => ({
            stationName: m.station_name,
            latitude: m.latitude,
            longitude: m.longitude
        }));
        mapTimetableToMarkers(timetableEntries, processedMarkers);

        // Clean up entries for export (remove internal fields)
        const exportEntries = timetableEntries.map(e => {
            const result = {
                index: e.index,
                destination: e.destination,
                arrival: e.arrival,
                departure: e.departure,
                platform: e.platform,
                apiName: e.apiName
            };
            if (e.latitude != null) result.latitude = e.latitude;
            if (e.longitude != null) result.longitude = e.longitude;
            return result;
        });

        // Build the export object (same format as processed routes)
        const exportData = {
            routeName: timetable.service_name,
            timetableId: timetable.id,
            routeId: timetable.route_id,
            trainId: timetable.train_id,
            routeDisplayName: routeName,
            trainDisplayName: trainName,
            totalPoints: coordinates.length,
            totalMarkers: markers.length,
            coordinates: coordinates.map(c => ({
                latitude: c.latitude,
                longitude: c.longitude,
                height: c.height || null,
                gradient: c.gradient || null
            })),
            markers: markers.map(m => ({
                stationName: m.station_name,
                markerType: m.marker_type,
                latitude: m.latitude,
                longitude: m.longitude,
                platformLength: m.platform_length
            })),
            timetable: exportEntries
        };

        sendJson(res, exportData);
    },

    // GET /api/timetables/:id/export/download
    // Export as downloadable JSON file
    exportDownload: async (req, res, id) => {
        const timetable = timetableDb.getById(id);
        if (!timetable) {
            sendJson(res, { error: 'Timetable not found' }, 404);
            return;
        }

        // Get related data
        const entries = entryDb.getByTimetableId(id);
        const coordinates = timetableCoordinateDb.getByTimetableId(id);
        const markers = timetableMarkerDb.getByTimetableId(id);

        // Load station name mapping from database
        let stationNameMapping = {};
        if (timetable.route_id) {
            stationNameMapping = stationMappingDb.getMappingObject(timetable.route_id);
        } else {
            stationNameMapping = stationMappingDb.getMappingObject(null);
        }

        // Pre-process raw timetable entries into proper station entries
        const timetableEntries = preprocessTimetableEntries(entries, stationNameMapping);

        // Preserve any user-entered coordinates from original entries
        // Only match if destination is not empty to avoid false matches
        for (const entry of timetableEntries) {
            if (!entry.destination || !entry.destination.trim()) {
                continue; // Skip entries with empty destination
            }
            const originalEntry = entries.find(e =>
                (e.location || e.details) === entry.destination &&
                e.latitude && e.longitude
            );
            if (originalEntry) {
                entry.latitude = parseFloat(originalEntry.latitude);
                entry.longitude = parseFloat(originalEntry.longitude);
            }
        }

        // Calculate marker positions if we have coordinates
        if (coordinates.length > 0) {
            calculateMarkerPositions(markers, coordinates);
        }

        // Map timetable entries to marker coordinates (EXACT apiName matching only)
        const processedMarkers = markers.map(m => ({
            stationName: m.station_name,
            latitude: m.latitude,
            longitude: m.longitude
        }));
        mapTimetableToMarkers(timetableEntries, processedMarkers);

        // Clean up entries for export (remove internal fields)
        const exportEntries = timetableEntries.map(e => {
            const result = {
                index: e.index,
                destination: e.destination,
                arrival: e.arrival,
                departure: e.departure,
                platform: e.platform,
                apiName: e.apiName
            };
            if (e.latitude != null) result.latitude = e.latitude;
            if (e.longitude != null) result.longitude = e.longitude;
            return result;
        });

        // Build the export object
        const exportData = {
            routeName: timetable.service_name,
            timetableId: timetable.id,
            totalPoints: coordinates.length,
            totalMarkers: markers.length,
            coordinates: coordinates.map(c => ({
                latitude: c.latitude,
                longitude: c.longitude,
                height: c.height || null,
                gradient: c.gradient || null
            })),
            markers: markers.map(m => ({
                stationName: m.station_name,
                markerType: m.marker_type,
                latitude: m.latitude,
                longitude: m.longitude,
                platformLength: m.platform_length
            })),
            timetable: exportEntries
        };

        // Create a safe filename
        const safeServiceName = timetable.service_name
            .replace(/[^a-z0-9]/gi, '_')
            .replace(/_+/g, '_')
            .substring(0, 50);
        const filename = `${safeServiceName}_${id}.json`;

        // Send as downloadable file
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${filename}"`
        });
        res.end(JSON.stringify(exportData, null, 2));
    }
};

module.exports = timetableController;
