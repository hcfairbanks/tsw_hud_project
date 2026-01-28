'use strict';
const { timetableDb, entryDb, timetableCoordinateDb, timetableMarkerDb, routeDb, trainDb, countryDb, stationMappingDb, saveDatabase } = require('../db');
const { sendJson, parseBody } = require('../utils/http');
const { preprocessTimetableEntries, calculateMarkerPositions, mapTimetableToMarkers } = require('./processingController');
const { loadConfig } = require('./configController');

// Time format validation helper (HH:MM:SS)
const TIME_FORMAT_REGEX = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/;

function isValidTimeFormat(time) {
    if (!time || time.trim() === '') return true; // Empty is allowed
    return TIME_FORMAT_REGEX.test(time);
}

function validateEntryTimes(entries) {
    const invalidEntries = [];
    entries.forEach((entry, index) => {
        if (entry.time1 && !isValidTimeFormat(entry.time1)) {
            invalidEntries.push({ index: index + 1, field: 'time1', value: entry.time1 });
        }
        if (entry.time2 && !isValidTimeFormat(entry.time2)) {
            invalidEntries.push({ index: index + 1, field: 'time2', value: entry.time2 });
        }
    });
    return invalidEntries;
}

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
 * Get timetable metadata for export (serviceName, routeName, countryName, trainName/trainNames, contributor, coordinates_contributor)
 * @param {Object} timetable - Timetable object with route_id and train_id
 * @returns {Object} - { serviceName, routeName, countryName, trainNames, contributor, coordinates_contributor }
 */
function getTimetableExportMetadata(timetable) {
    let routeName = null;
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
    }

    return {
        serviceName: timetable ? timetable.service_name : 'Unknown',
        routeName: routeName,
        countryName: countryName,
        trainNames: trainNames,
        serviceType: timetable ? (timetable.service_type || 'passenger') : 'passenger',
        contributor: timetable ? timetable.contributor : null,
        coordinates_contributor: timetable ? timetable.coordinates_contributor : null
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
            if (!entry.location || !entry.location.trim()) {
                continue;
            }
            const originalEntry = entries.find(e =>
                (e.location || e.details) === entry.location &&
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
            location: e.location,
            arrival: e.arrival,
            departure: e.departure,
            platform: e.platform,
            apiName: e.apiName
        };

        // Include isPassThrough flag for GO VIA LOCATION entries
        if (e.isPassThrough) {
            result.isPassThrough = true;
        }

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
        // Preserve gameTime if it exists (in-game time from recording)
        if (c.gameTime) {
            coord.gameTime = c.gameTime;
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
        trainNames: metadata.trainNames || [],
        serviceType: metadata.serviceType || 'passenger',
        contributor: metadata.contributor || null,
        coordinates_contributor: metadata.coordinates_contributor || null,
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

        // Add coordinate counts, trains array, and coordinates_complete status
        const timetablesWithCounts = timetables.map(t => {
            const trains = timetableDb.getTrains(t.id);
            const entries = entryDb.getByTimetableId(t.id);

            // Check if any entries have valid coordinates
            // A timetable is completed if at least one entry has valid latitude/longitude
            const coordinates_complete = entries.some(entry => {
                const lat = parseFloat(entry.latitude);
                const lng = parseFloat(entry.longitude);
                return !isNaN(lat) && !isNaN(lng) && (lat !== 0 || lng !== 0);
            });

            return {
                ...t,
                trains: trains,
                coordinate_count: timetableCoordinateDb.getCount(t.id),
                entry_count: entries.length,
                coordinates_complete: coordinates_complete
            };
        });

        sendJson(res, timetablesWithCounts);
    },

    // POST /api/timetables
    create: async (req, res) => {
        const body = await parseBody(req);
        console.log('=== CREATE TIMETABLE ===');
        console.log('Body received:', JSON.stringify(body, null, 2));

        // Step 1: Validate required fields
        const serviceName = body.service_name ? body.service_name.trim() : '';

        // Validate service name is provided
        if (!serviceName) {
            return sendJson(res, { error: 'A timetable must have a service name.' }, 400);
        }

        // Validate route is provided
        if (!body.route_id) {
            return sendJson(res, { error: 'A timetable must have a route. Please select a route.' }, 400);
        }

        // Validate at least one train is provided
        const trainIds = body.train_ids || (body.train_id ? [body.train_id] : null);
        if (!trainIds || trainIds.length === 0) {
            return sendJson(res, { error: 'A timetable must have at least one train. Please select a train.' }, 400);
        }

        // Check for unique service name
        if (timetableDb.serviceNameExists(serviceName)) {
            return sendJson(res, { error: 'A timetable with this service name already exists' }, 409);
        }

        // Verify the route exists
        const route = routeDb.getById(body.route_id);
        if (!route) {
            return sendJson(res, { error: 'The specified route does not exist' }, 400);
        }

        // Verify all trains exist
        for (const tid of trainIds) {
            const train = trainDb.getById(tid);
            if (!train) {
                return sendJson(res, { error: `Train with ID ${tid} does not exist` }, 400);
            }
        }

        // Validate time format for all entries (HH:MM:SS)
        const entriesForValidation = body.entries || [];
        const invalidTimes = validateEntryTimes(entriesForValidation);
        if (invalidTimes.length > 0) {
            const errorDetails = invalidTimes.map(e => `Entry ${e.index} ${e.field}: "${e.value}"`).join(', ');
            return sendJson(res, { error: `Invalid time format. Times must be HH:MM:SS (e.g., 08:30:00). ${errorDetails}` }, 400);
        }

        // Validate first entry has a location
        if (entriesForValidation.length > 0) {
            const firstEntry = entriesForValidation[0];
            const firstLocation = (firstEntry.location || '').trim();
            if (!firstLocation) {
                return sendJson(res, { error: 'The first entry must have a location name.' }, 400);
            }
        }

        const routeId = body.route_id;
        const trainId = body.train_id || trainIds[0];  // Use first train for backward compatibility
        const serviceType = body.service_type || 'passenger';

        // Get contributor name from config
        const config = loadConfig();
        const contributor = config.contributorName || null;

        const result = timetableDb.create(serviceName, routeId, trainId, trainIds, contributor, serviceType);
        const timetableId = result.lastInsertRowid;
        console.log('Timetable created with ID:', timetableId, 'route_id:', routeId, 'train_id:', trainId, 'train_ids:', trainIds, 'service_type:', serviceType, 'contributor:', contributor);

        // Step 2: Deduplicate entries based on unique key
        // An entry is considered duplicate if it has the same action, time1/time2, AND location
        // Location is needed because GO VIA LOCATION entries have no times but different locations
        let entries = body.entries || [];
        if (entries.length > 0) {
            const seenKeys = new Set();
            const uniqueEntries = [];

            for (const entry of entries) {
                // Create a unique key based on action + time1 + time2 + location
                const time1 = (entry.time1 || '').trim();
                const time2 = (entry.time2 || '').trim();
                const action = (entry.action || '').trim();
                const location = (entry.location || '').trim();

                // Include location in key to differentiate entries with same action but no times
                const entryKey = `${action}|${time1}|${time2}|${location}`;

                if (!seenKeys.has(entryKey)) {
                    seenKeys.add(entryKey);
                    uniqueEntries.push(entry);
                } else {
                    console.log(`Skipping duplicate entry: ${action} at ${location || time1 || time2}`);
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
            service_type: serviceType,
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

        // Get current timetable to check existing values
        const currentTimetable = timetableDb.getById(id);
        if (!currentTimetable) {
            return sendJson(res, { error: 'Timetable not found' }, 404);
        }

        // Validate service name if being updated
        if (body.service_name !== undefined) {
            const trimmedName = body.service_name.trim();
            if (!trimmedName) {
                return sendJson(res, { error: 'A timetable must have a service name.' }, 400);
            }
            // Check for unique service name (excluding current timetable)
            if (timetableDb.serviceNameExists(trimmedName, parseInt(id))) {
                return sendJson(res, { error: 'A timetable with this service name already exists' }, 409);
            }
        }

        // Determine final route_id after update
        const finalRouteId = body.route_id !== undefined ? body.route_id : currentTimetable.route_id;
        if (!finalRouteId) {
            return sendJson(res, { error: 'A timetable must have a route. Please select a route.' }, 400);
        }

        // Verify the route exists if being changed
        if (body.route_id !== undefined) {
            const route = routeDb.getById(body.route_id);
            if (!route) {
                return sendJson(res, { error: 'The specified route does not exist' }, 400);
            }
        }

        // Determine final train_ids after update
        let finalTrainIds;
        if (body.train_ids !== undefined) {
            finalTrainIds = body.train_ids;
        } else {
            // Get current trains from junction table
            const currentTrains = timetableDb.getTrains(id);
            finalTrainIds = currentTrains.map(t => t.id);
        }

        if (!finalTrainIds || finalTrainIds.length === 0) {
            return sendJson(res, { error: 'A timetable must have at least one train. Please select a train.' }, 400);
        }

        // Verify all new trains exist
        if (body.train_ids !== undefined) {
            for (const tid of body.train_ids) {
                const train = trainDb.getById(tid);
                if (!train) {
                    return sendJson(res, { error: `Train with ID ${tid} does not exist` }, 400);
                }
            }
        }

        // Build update data object with only the fields that were provided
        const updateData = {};
        if (body.service_name !== undefined) updateData.service_name = body.service_name;
        if (body.route_id !== undefined) updateData.route_id = body.route_id;
        if (body.train_id !== undefined) updateData.train_id = body.train_id;
        if (body.train_ids !== undefined) updateData.train_ids = body.train_ids;
        if (body.service_type !== undefined) updateData.service_type = body.service_type;

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
        // Only match if location is not empty to avoid false matches
        for (const entry of timetableEntries) {
            if (!entry.location || !entry.location.trim()) {
                continue; // Skip entries with empty location
            }
            const originalEntry = entries.find(e =>
                (e.location || e.details) === entry.location &&
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
                location: e.location,
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

        // Step 3: Look up trains by name (trains must already exist)
        let trainIds = [];
        let trainId = null;
        let missingTrains = [];

        // Get train names from trainNames array and deduplicate
        const trainNamesToProcess = body.trainNames && Array.isArray(body.trainNames)
            ? [...new Set(body.trainNames.filter(name => typeof name === 'string' && name.trim().length > 0))]
            : [];

        console.log('trainNamesToProcess:', JSON.stringify(trainNamesToProcess));

        for (const trainName of trainNamesToProcess) {
            const existingTrain = trainDb.getByName(trainName);
            if (existingTrain) {
                trainIds.push(existingTrain.id);
                console.log(`Found existing train: ${trainName} (ID: ${existingTrain.id})`);
            } else {
                missingTrains.push(trainName);
                console.log(`Train not found: ${trainName}`);
            }
        }

        // Reject import if any trains are missing
        if (missingTrains.length > 0) {
            const trainList = missingTrains.map(t => `"${t}"`).join(', ');
            sendJson(res, {
                error: `The following trains do not exist: ${trainList}. Please create them first.`,
                missingTrains: missingTrains
            }, 400);
            return;
        }

        // For backward compatibility, set trainId to first train
        trainId = trainIds.length > 0 ? trainIds[0] : null;

        // Validate time format for csvData entries (HH:MM:SS)
        if (body.csvData && Array.isArray(body.csvData) && body.csvData.length > 0) {
            // Transform csvData to match validation format (handles old arrival/departure format too)
            const entriesToValidate = body.csvData.map(csvEntry => {
                const hasNewFormat = csvEntry.time1 !== undefined || csvEntry.time2 !== undefined;
                return {
                    time1: hasNewFormat ? (csvEntry.time1 || '') : (csvEntry.arrival || ''),
                    time2: hasNewFormat ? (csvEntry.time2 || '') : (csvEntry.departure || '')
                };
            });
            const invalidTimes = validateEntryTimes(entriesToValidate);
            if (invalidTimes.length > 0) {
                const errorDetails = invalidTimes.map(e => `Entry ${e.index} ${e.field}: "${e.value}"`).join(', ');
                return sendJson(res, { error: `Invalid time format. Times must be HH:MM:SS (e.g., 08:30:00). ${errorDetails}` }, 400);
            }
        }

        // Step 4: Create the timetable with route and train IDs (include contributor and serviceType from import)
        const importedContributor = body.contributor || null;
        const importedServiceType = body.serviceType || 'passenger';
        const result = timetableDb.create(serviceName, routeId, trainId, trainIds, importedContributor, importedServiceType);
        const timetableId = result.lastInsertRowid;
        console.log('Timetable created with ID:', timetableId, 'route_id:', routeId, 'train_ids:', trainIds, 'service_type:', importedServiceType, 'contributor:', importedContributor);

        // Step 5: Import coordinates if present
        if (body.coordinates && Array.isArray(body.coordinates) && body.coordinates.length > 0) {
            console.log(`Importing ${body.coordinates.length} coordinates...`);
            timetableCoordinateDb.insert(timetableId, body.coordinates);

            // Set coordinates_contributor from import if present
            if (body.coordinates_contributor) {
                timetableDb.update(timetableId, { coordinates_contributor: body.coordinates_contributor });
                console.log(`Set coordinates_contributor from import: ${body.coordinates_contributor}`);
            }
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
            train_ids: trainIds,
            train_names: trainNamesToProcess,
            service_type: importedServiceType,
            contributor: importedContributor,
            coordinates_contributor: body.coordinates_contributor || null,
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

    // DELETE /api/timetables/:id/trains (train_id in body)
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
    },

    // DELETE /api/timetables/:id/trains/:trainId (train_id in URL)
    removeTrainById: async (req, res, timetableId, trainId) => {
        const timetable = timetableDb.getById(timetableId);
        if (!timetable) {
            return sendJson(res, { error: 'Timetable not found' }, 404);
        }
        timetableDb.removeTrain(timetableId, trainId);
        const trains = timetableDb.getTrains(timetableId);
        sendJson(res, { success: true, trains: trains });
    }
};

module.exports = timetableController;

// Export helper functions for use by other controllers (e.g., recordingController)
module.exports.getTimetableExportMetadata = getTimetableExportMetadata;
module.exports.buildTimetableExportJson = buildTimetableExportJson;
