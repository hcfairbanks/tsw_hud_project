'use strict';
const { timetableDb, entryDb, timetableCoordinateDb, timetableMarkerDb, routeDb, trainDb, stationMappingDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');
const { preprocessTimetableEntries, calculateMarkerPositions, mapTimetableToMarkers } = require('./processingController');

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

        console.log('=== TIMETABLE CREATION COMPLETE ===');
        sendJson(res, {
            id: timetableId,
            service_name: serviceName,
            route_id: routeId,
            train_id: trainId,
            entries: savedEntries
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
