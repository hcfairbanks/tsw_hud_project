'use strict';
const { timetableDb, entryDb, timetableCoordinateDb, timetableMarkerDb, routeDb, trainDb, countryDb, stationMappingDb, saveDatabase } = require('../db');
const { sendJson, parseBody } = require('../utils/http');
const { preprocessTimetableEntries, calculateMarkerPositions, mapTimetableToMarkers } = require('./processingController');

// Helper function to generate raw entry data for export
// Preserves the original database structure (time1/time2) for accurate import
function generateRawEntryData(entries) {
    return entries.map((entry, index) => ({
        index,
        action: entry.action || '',
        location: entry.location || '',
        platform: entry.platform || '',
        time1: entry.time1 || '',
        time2: entry.time2 || '',
        details: entry.details || '',
        latitude: (entry.latitude !== null && entry.latitude !== undefined && entry.latitude !== '')
            ? String(entry.latitude) : '',
        longitude: (entry.longitude !== null && entry.longitude !== undefined && entry.longitude !== '')
            ? String(entry.longitude) : '',
        api_name: entry.api_name || ''
    }));
}

/**
 * Get timetable metadata for export (serviceName, routeName, countryName, trainName/trainNames)
 * @param {Object} timetable - Timetable object with route_id and train_id
 * @returns {Object} - { serviceName, routeName, countryName, trainName, trainNames }
 */
function getTimetableExportMetadata(timetable) {
    let routeName = null;
    let trainName = null;
    let trainNames = [];
    let countryName = null;

    if (timetable && timetable.route_id) {
        const route = routeDb.getById(timetable.route_id);
        routeName = route ? route.name : null;
        if (route && route.country_id) {
            const country = countryDb.getById(route.country_id);
            countryName = country ? country.name : null;
        }
    }

    // Get all trains from junction table
    if (timetable && timetable.id) {
        const trains = timetableDb.getTrains(timetable.id);
        trainNames = trains.map(t => t.name);
        // For backward compatibility, set trainName to first train
        trainName = trainNames.length > 0 ? trainNames[0] : null;
    }

    // Fallback to legacy train_id if no trains in junction table
    if (!trainName && timetable && timetable.train_id) {
        const train = trainDb.getById(timetable.train_id);
        trainName = train ? train.name : null;
        if (trainName) {
            trainNames = [trainName];
        }
    }

    return {
        serviceName: timetable ? timetable.service_name : 'Unknown',
        routeName: routeName,
        countryName: countryName,
        trainName: trainName,
        trainNames: trainNames
    };
}

/**
 * Build the complete export JSON for a timetable
 * This is the SINGLE source of truth for timetable export format.
 * Used by both timetableController.exportDownload and recordingController.saveRouteData
 *
 * @param {Object} options - Export options
 * @param {Object} options.timetable - Timetable object (required)
 * @param {Array} options.entries - Raw timetable entries from database (required)
 * @param {Array} options.coordinates - Coordinate array (from DB or recording)
 * @param {Array} options.markers - Marker array (from DB or recording)
 * @param {Map|null} options.savedTimetableCoords - Optional Map of index -> {latitude, longitude} for recording
 * @param {boolean} options.includeCsvData - Whether to include csvData (default: true)
 * @param {boolean} options.includeMarkerProcessing - Whether to process markers (default: true for DB, false for recording)
 * @param {boolean|null} options.completed - Recording completion status (null = not a recording file, false = in progress, true = completed)
 * @returns {Object} - Complete export JSON object
 */
function buildTimetableExportJson(options) {
    const {
        timetable,
        entries,
        coordinates = [],
        markers = [],
        savedTimetableCoords = null,
        includeCsvData = true,
        includeMarkerProcessing = true,
        completed = null,
        recordingMode = null  // 'manual' or 'automatic'
    } = options;

    // Get metadata (serviceName, routeName, countryName, trainName)
    const metadata = getTimetableExportMetadata(timetable);

    // Load station name mapping from database
    let stationNameMapping = {};
    if (timetable && timetable.route_id) {
        stationNameMapping = stationMappingDb.getMappingObject(timetable.route_id);
    } else {
        stationNameMapping = stationMappingDb.getMappingObject(null);
    }

    // Pre-process raw timetable entries into proper station entries
    const timetableEntries = preprocessTimetableEntries(entries, stationNameMapping);

    // Preserve any user-entered coordinates from original entries (for DB export)
    if (!savedTimetableCoords) {
        for (const entry of timetableEntries) {
            if (!entry.destination || !entry.destination.trim()) {
                continue;
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
    }

    // Process markers if requested (for DB export with calculated positions)
    let processedMarkers = markers;
    if (includeMarkerProcessing && coordinates.length > 0 && markers.length > 0) {
        // Calculate marker positions from coordinates
        calculateMarkerPositions(markers, coordinates);

        // Map timetable entries to marker coordinates
        const markerData = markers.map(m => ({
            stationName: m.station_name || m.stationName,
            latitude: m.latitude,
            longitude: m.longitude
        }));
        mapTimetableToMarkers(timetableEntries, markerData);
    }

    // Build export entries
    const exportEntries = timetableEntries.map((e, idx) => {
        const result = {
            index: e.index,
            destination: e.destination,
            arrival: e.arrival,
            departure: e.departure,
            platform: e.platform,
            apiName: e.apiName
        };

        // Use savedTimetableCoords if provided (recording), otherwise use entry coords
        if (savedTimetableCoords) {
            const savedCoords = savedTimetableCoords.get(idx);
            if (savedCoords) {
                result.latitude = savedCoords.latitude;
                result.longitude = savedCoords.longitude;
            }
        } else {
            if (e.latitude != null) result.latitude = e.latitude;
            if (e.longitude != null) result.longitude = e.longitude;
        }
        return result;
    });

    // Format coordinates (preserve timestamp if present)
    const formattedCoordinates = coordinates.map(c => {
        const coord = {
            latitude: c.latitude,
            longitude: c.longitude,
            height: c.height != null ? c.height : null,
            gradient: c.gradient != null ? c.gradient : (c.gradient === 0 ? 0 : null)
        };
        // Preserve timestamp if it exists (from recording)
        if (c.timestamp) {
            coord.timestamp = c.timestamp;
        }
        return coord;
    });

    // Format markers - handle both DB format (station_name) and recording format (stationName)
    const exportMarkers = markers.map(m => {
        const marker = {
            stationName: m.station_name || m.stationName,
            markerType: m.marker_type || m.markerType || 'Station'
        };

        // Include position data
        if (m.latitude != null) marker.latitude = m.latitude;
        if (m.longitude != null) marker.longitude = m.longitude;
        if (m.platform_length != null) marker.platformLength = m.platform_length;
        if (m.platformLength != null) marker.platformLength = m.platformLength;

        // Include recording-specific data if present
        if (m.detectedAt) marker.detectedAt = m.detectedAt;
        if (m.distanceAheadMeters != null) marker.distanceAheadMeters = m.distanceAheadMeters;
        if (m.onspot_latitude != null) {
            marker.onspot_latitude = m.onspot_latitude;
            marker.onspot_longitude = m.onspot_longitude;
            marker.onspot_distance = m.onspot_distance;
        }

        return marker;
    });

    // Build the export object
    const exportData = {
        timetableId: timetable ? timetable.id : null,
        completed: completed,
        recordingMode: recordingMode,  // 'manual' or 'automatic'
        serviceName: metadata.serviceName,
        routeName: metadata.routeName,
        countryName: metadata.countryName,
        trainName: metadata.trainName,
        trainNames: metadata.trainNames || [],  // New: array of train names
        totalPoints: formattedCoordinates.length,
        totalMarkers: exportMarkers.length,
        coordinates: formattedCoordinates,
        markers: exportMarkers,
        timetable: exportEntries
    };

    // Include csvData if requested (for DB export/download)
    if (includeCsvData) {
        exportData.csvData = generateRawEntryData(entries);
    }

    return exportData;
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

        // Filter by train_id if provided - check both legacy train_id and junction table
        if (trainId) {
            timetables = timetables.filter(t => {
                // Check legacy train_id
                if (t.train_id === trainId) return true;
                // Check junction table
                const trains = timetableDb.getTrains(t.id);
                return trains.some(train => train.id === trainId);
            });
        }

        // Add coordinate counts and trains array
        const timetablesWithCounts = timetables.map(t => {
            const trains = timetableDb.getTrains(t.id);
            return {
                ...t,
                trains: trains,
                coordinate_count: timetableCoordinateDb.getCount(t.id)
            };
        });

        sendJson(res, timetablesWithCounts);
    },

    // POST /api/timetables
    create: async (req, res) => {
        const body = await parseBody(req);
        console.log('=== CREATE TIMETABLE ===');
        console.log('Body received:', JSON.stringify(body, null, 2));

        // Step 1: Create the timetable
        const serviceName = body.service_name || 'Untitled';

        // Check for unique service name
        if (timetableDb.serviceNameExists(serviceName)) {
            return sendJson(res, { error: 'A timetable with this service name already exists' }, 409);
        }

        const routeId = body.route_id || null;
        const trainId = body.train_id || null;
        const trainIds = body.train_ids || null;  // New: array of train IDs
        const result = timetableDb.create(serviceName, routeId, trainId, trainIds);
        const timetableId = result.lastInsertRowid;
        console.log('Timetable created with ID:', timetableId, 'route_id:', routeId, 'train_id:', trainId, 'train_ids:', trainIds);

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
            timetable.trains = timetableDb.getTrains(id);
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

        // Check for unique service name (excluding current timetable)
        if (body.service_name !== undefined && timetableDb.serviceNameExists(body.service_name, parseInt(id))) {
            return sendJson(res, { error: 'A timetable with this service name already exists' }, 409);
        }

        // Build update data object with only the fields that were provided
        const updateData = {};
        if (body.service_name !== undefined) updateData.service_name = body.service_name;
        if (body.route_id !== undefined) updateData.route_id = body.route_id;
        if (body.train_id !== undefined) updateData.train_id = body.train_id;
        if (body.train_ids !== undefined) updateData.train_ids = body.train_ids;  // New: array of train IDs

        timetableDb.update(id, updateData);

        // Return the updated timetable with trains
        const updated = timetableDb.getById(id);
        updated.trains = timetableDb.getTrains(id);
        sendJson(res, updated);
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

        // Generate CSV data from raw entries
        const csvData = generateRawEntryData(entries);

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
                height: c.height != null ? c.height : null,
                gradient: c.gradient != null ? c.gradient : null
            })),
            markers: markers.map(m => ({
                stationName: m.station_name,
                markerType: m.marker_type,
                latitude: m.latitude,
                longitude: m.longitude,
                platformLength: m.platform_length
            })),
            timetable: exportEntries,
            csvData: csvData
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

        // Use the shared function to build export JSON
        const exportData = buildTimetableExportJson({
            timetable,
            entries,
            coordinates,
            markers,
            includeCsvData: true,
            includeMarkerProcessing: true
        });

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
    },

    // POST /api/timetables/import
    // Import a timetable from exported JSON format
    import: async (req, res) => {
        const body = await parseBody(req);
        console.log('=== IMPORT TIMETABLE ===');

        // Validate required fields - support both old (routeName) and new (serviceName) formats
        const serviceName = body.serviceName || body.routeName;
        if (!serviceName) {
            sendJson(res, { error: 'Missing required field: serviceName or routeName' }, 400);
            return;
        }

        // Check if a timetable with this service name already exists
        const existingTimetable = timetableDb.getByServiceName(serviceName);
        if (existingTimetable) {
            console.log(`Import rejected: Timetable with service name "${serviceName}" already exists (ID: ${existingTimetable.id})`);
            sendJson(res, {
                error: `A timetable with the service name "${serviceName}" already exists`,
                existingId: existingTimetable.id
            }, 409);
            return;
        }

        // Step 1: Look up or create country by name
        // Country is required when routeName is provided (since routes need a country)
        let countryId = null;
        let countryCreated = false;
        if (body.routeName && !body.countryName) {
            sendJson(res, { error: 'Country of route missing in import file' }, 400);
            return;
        }
        if (body.countryName) {
            const existingCountry = countryDb.getByName(body.countryName);
            if (existingCountry) {
                countryId = existingCountry.id;
                console.log(`Found existing country: ${body.countryName} (ID: ${countryId})`);
            } else {
                // Create new country
                const countryResult = countryDb.create(body.countryName);
                countryId = countryResult.lastInsertRowid;
                countryCreated = true;
                console.log(`Created new country: ${body.countryName} (ID: ${countryId})`);
            }
        }
        console.log(`After country step: countryId = ${countryId}`);

        // Step 2: Look up or create route by name
        let routeId = null;
        let routeCreated = false;
        if (body.routeName) {
            const existingRoute = routeDb.getByName(body.routeName);
            if (existingRoute) {
                routeId = existingRoute.id;
                console.log(`Found existing route: ${body.routeName} (ID: ${routeId})`);
            } else {
                // Create new route with the country from import and TSW version 3
                console.log(`Creating new route "${body.routeName}" with countryId: ${countryId}`);
                const routeResult = routeDb.create(body.routeName, countryId, 3);
                routeId = routeResult.lastInsertRowid;
                routeCreated = true;
                console.log(`Created new route: ${body.routeName} (ID: ${routeId}, country_id: ${countryId})`);
            }
        }

        // Step 3: Look up or create trains by name
        // Support both trainName (single) and trainNames (array)
        let trainIds = [];
        let trainId = null;
        let trainCreated = false;
        let trainsCreated = [];

        // Get train names from either trainNames array or single trainName
        const trainNamesToProcess = body.trainNames && Array.isArray(body.trainNames) && body.trainNames.length > 0
            ? body.trainNames
            : (body.trainName ? [body.trainName] : []);

        for (const trainName of trainNamesToProcess) {
            const existingTrain = trainDb.getByName(trainName);
            if (existingTrain) {
                trainIds.push(existingTrain.id);
                console.log(`Found existing train: ${trainName} (ID: ${existingTrain.id})`);
            } else {
                // Create new train
                const trainResult = trainDb.create(trainName);
                trainIds.push(trainResult.lastInsertRowid);
                trainsCreated.push(trainName);
                console.log(`Created new train: ${trainName} (ID: ${trainResult.lastInsertRowid})`);
            }
        }

        // For backward compatibility, set trainId to first train
        trainId = trainIds.length > 0 ? trainIds[0] : null;
        trainCreated = trainsCreated.length > 0;

        // Step 4: Create the timetable with route and train IDs
        const result = timetableDb.create(serviceName, routeId, trainId, trainIds);
        const timetableId = result.lastInsertRowid;
        console.log('Timetable created with ID:', timetableId, 'route_id:', routeId, 'train_ids:', trainIds);

        // Step 5: Import coordinates if present
        if (body.coordinates && Array.isArray(body.coordinates) && body.coordinates.length > 0) {
            console.log(`Importing ${body.coordinates.length} coordinates...`);
            timetableCoordinateDb.insert(timetableId, body.coordinates);
        }

        // Step 6: Import markers if present
        if (body.markers && Array.isArray(body.markers) && body.markers.length > 0) {
            console.log(`Importing ${body.markers.length} markers...`);
            timetableMarkerDb.bulkInsert(timetableId, body.markers);
        }

        // Step 7: Import entries from csvData (the raw timetable entries)
        // Supports both new format (time1/time2) and old format (arrival/departure)
        if (body.csvData && Array.isArray(body.csvData) && body.csvData.length > 0) {
            console.log(`Importing ${body.csvData.length} entries from csvData...`);
            for (let i = 0; i < body.csvData.length; i++) {
                const csvEntry = body.csvData[i];
                // New format uses time1/time2 directly, old format uses arrival/departure
                const hasNewFormat = csvEntry.time1 !== undefined || csvEntry.time2 !== undefined;
                const entry = {
                    action: csvEntry.action || '',
                    details: csvEntry.details || '',
                    location: csvEntry.location || '',
                    platform: csvEntry.platform || '',
                    time1: hasNewFormat ? (csvEntry.time1 || '') : (csvEntry.arrival || ''),
                    time2: hasNewFormat ? (csvEntry.time2 || '') : (csvEntry.departure || ''),
                    latitude: csvEntry.latitude || '',
                    longitude: csvEntry.longitude || '',
                    api_name: csvEntry.api_name || ''
                };
                entryDb.create(timetableId, entry, i);
            }
        }

        saveDatabase();

        console.log('=== TIMETABLE IMPORT COMPLETE ===');
        sendJson(res, {
            id: timetableId,
            service_name: serviceName,
            country_id: countryId,
            country_name: body.countryName || null,
            country_created: countryCreated,
            route_id: routeId,
            route_name: body.routeName || null,
            route_created: routeCreated,
            train_id: trainId,
            train_name: body.trainName || null,
            train_created: trainCreated,
            message: 'Timetable imported successfully',
            coordinatesImported: body.coordinates ? body.coordinates.length : 0,
            markersImported: body.markers ? body.markers.length : 0,
            entriesImported: body.csvData ? body.csvData.length : 0
        }, 201);
    },

    // GET /api/timetables/:id/trains
    getTrains: async (req, res, timetableId) => {
        const timetable = timetableDb.getById(timetableId);
        if (!timetable) {
            return sendJson(res, { error: 'Timetable not found' }, 404);
        }
        const trains = timetableDb.getTrains(timetableId);
        sendJson(res, trains);
    },

    // POST /api/timetables/:id/trains
    addTrain: async (req, res, timetableId) => {
        const timetable = timetableDb.getById(timetableId);
        if (!timetable) {
            return sendJson(res, { error: 'Timetable not found' }, 404);
        }
        const body = await parseBody(req);
        if (!body.train_id) {
            return sendJson(res, { error: 'train_id is required' }, 400);
        }
        timetableDb.addTrain(timetableId, body.train_id);
        const trains = timetableDb.getTrains(timetableId);
        sendJson(res, { success: true, trains: trains }, 201);
    },

    // DELETE /api/timetables/:id/trains
    removeTrain: async (req, res, timetableId) => {
        const timetable = timetableDb.getById(timetableId);
        if (!timetable) {
            return sendJson(res, { error: 'Timetable not found' }, 404);
        }
        const body = await parseBody(req);
        if (!body.train_id) {
            return sendJson(res, { error: 'train_id is required' }, 400);
        }
        timetableDb.removeTrain(timetableId, body.train_id);
        const trains = timetableDb.getTrains(timetableId);
        sendJson(res, { success: true, trains: trains });
    }
};

module.exports = timetableController;

// Export helper functions for use by other controllers (e.g., recordingController)
module.exports.getTimetableExportMetadata = getTimetableExportMetadata;
module.exports.buildTimetableExportJson = buildTimetableExportJson;
