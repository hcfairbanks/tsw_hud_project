'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson, parseBody } = require('../utils/http');
const { timetableDb, entryDb, timetableCoordinateDb, timetableMarkerDb, routeDb, stationMappingDb } = require('../db');

// Get the directory where the app is running from
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

/**
 * Calculate distance between two lat/lng points using Haversine formula
 * Returns distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Find the nearest route coordinate to a given position
 * Returns the index of the nearest coordinate
 */
function findNearestCoordinateIndex(coordinates, targetLat, targetLon) {
    let minDistance = Infinity;
    let nearestIndex = 0;

    for (let i = 0; i < coordinates.length; i++) {
        const coord = coordinates[i];
        const distance = calculateDistance(
            targetLat,
            targetLon,
            coord.latitude,
            coord.longitude
        );

        if (distance < minDistance) {
            minDistance = distance;
            nearestIndex = i;
        }
    }

    return nearestIndex;
}

/**
 * Follow the route path from a starting coordinate index for a specified distance
 * Returns {latitude, longitude} of the point on the route that is distance meters ahead
 */
function followRoutePath(coordinates, startIndex, distanceMeters) {
    if (startIndex >= coordinates.length - 1) {
        // Already at or past the end
        const lastCoord = coordinates[coordinates.length - 1];
        return {
            latitude: lastCoord.latitude,
            longitude: lastCoord.longitude
        };
    }

    let remainingDistance = distanceMeters;
    let currentIndex = startIndex;

    // Walk along the route, accumulating distance
    while (currentIndex < coordinates.length - 1 && remainingDistance > 0) {
        const current = coordinates[currentIndex];
        const next = coordinates[currentIndex + 1];

        const segmentDistance = calculateDistance(
            current.latitude,
            current.longitude,
            next.latitude,
            next.longitude
        );

        if (segmentDistance >= remainingDistance) {
            // The target point is within this segment
            // Interpolate between current and next
            const ratio = remainingDistance / segmentDistance;
            return {
                latitude: current.latitude + (next.latitude - current.latitude) * ratio,
                longitude: current.longitude + (next.longitude - current.longitude) * ratio
            };
        }

        // Move to next segment
        remainingDistance -= segmentDistance;
        currentIndex++;
    }

    // Reached the end of the route
    const lastCoord = coordinates[coordinates.length - 1];
    return {
        latitude: lastCoord.latitude,
        longitude: lastCoord.longitude
    };
}

/**
 * Pre-process raw timetable entries into proper station entries
 * - WAIT FOR SERVICE + LOAD PASSENGERS = First station (arrival from WAIT, departure from LOAD)
 * - STOP AT LOCATION + LOAD PASSENGERS = Station stop (arrival from STOP, departure from LOAD)
 * - UNLOAD PASSENGERS = Final stop
 * - LOAD PASSENGERS alone is NOT a station entry
 *
 * @param {Array} rawEntries - Raw timetable entries from database
 * @param {Object} stationNameMapping - Map of display names to API names
 * @returns {Array} Processed station entries with proper arrival/departure times and apiName
 */
function preprocessTimetableEntries(rawEntries, stationNameMapping = {}) {
    // Same logic as ThirdRails export in show.html
    const processedEntries = [];
    let index = 0;

    for (let i = 0; i < rawEntries.length; i++) {
        const entry = rawEntries[i];
        const action = (entry.action || '').toUpperCase().trim();

        if (action === 'WAIT FOR SERVICE') {
            const destination = entry.location || '';
            const platform = entry.platform || '';
            // WAIT FOR SERVICE: arrival is time2
            const arrival = entry.time2 || '';
            let departure = '';

            // Look for following LOAD PASSENGERS to get departure time
            if (i + 1 < rawEntries.length) {
                const nextEntry = rawEntries[i + 1];
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
            const mappedDestination = stationNameMapping[destination] || destination;
            const apiName = (mappedDestination && platform) ? mappedDestination + ' ' + platform : '';

            processedEntries.push({
                index: index++,
                destination: destination,
                arrival: arrival,
                departure: departure,
                platform: platform,
                apiName: apiName,
                latitude: null,
                longitude: null
            });
        } else if (action === 'STOP AT LOCATION') {
            const destination = entry.location || '';
            const platform = entry.platform || '';
            // STOP AT LOCATION: arrival is time1
            const arrival = entry.time1 || '';
            let departure = '';

            // Look for following LOAD PASSENGERS to get departure time
            if (i + 1 < rawEntries.length) {
                const nextEntry = rawEntries[i + 1];
                if ((nextEntry.action || '').toUpperCase().trim() === 'LOAD PASSENGERS') {
                    departure = nextEntry.time1 || '';
                    i++; // Skip the LOAD PASSENGERS entry
                }
            }

            // Build apiName: mapped destination + " Platform " + platform
            const mappedDestination = stationNameMapping[destination] || destination;
            const apiName = (mappedDestination && platform) ? mappedDestination + ' ' + platform : '';

            processedEntries.push({
                index: index++,
                destination: destination,
                arrival: arrival,
                departure: departure,
                platform: platform,
                apiName: apiName,
                latitude: null,
                longitude: null
            });
        } else if (action === 'UNLOAD PASSENGERS') {
            // UNLOAD PASSENGERS with location = final stop
            const destination = entry.location || '';
            if (destination && destination !== '-') {
                const platform = entry.platform || '';
                const arrival = entry.time1 || '';
                const mappedDestination = stationNameMapping[destination] || destination;
                const apiName = (mappedDestination && platform) ? mappedDestination + ' ' + platform : '';

                processedEntries.push({
                    index: index++,
                    destination: destination,
                    arrival: arrival,
                    departure: '',
                    platform: platform,
                    apiName: apiName,
                    latitude: null,
                    longitude: null
                });
            }
        }
        // LOAD PASSENGERS alone is skipped - handled above with WAIT/STOP
    }

    return processedEntries;
}

/**
 * Calculate marker positions using the route path
 * Priority: 1) onspot + spoton_distance, 2) detectedAt + distanceAheadMeters
 */
function calculateMarkerPositions(markers, coordinates) {
    const results = {
        method1Count: 0,  // onspot
        method2Count: 0,  // detectedAt
        errorCount: 0
    };

    for (const marker of markers) {
        try {
            // Method 1: Use onspot position and spoton_distance (most accurate)
            if (marker.onspot_latitude && marker.onspot_longitude && marker.spoton_distance !== undefined) {
                const nearestIndex = findNearestCoordinateIndex(
                    coordinates,
                    marker.onspot_latitude,
                    marker.onspot_longitude
                );

                const position = followRoutePath(
                    coordinates,
                    nearestIndex,
                    marker.spoton_distance
                );

                marker.latitude = position.latitude;
                marker.longitude = position.longitude;
                marker.calculationMethod = 'onspot';
                results.method1Count++;
            }
            // Method 2: Use detectedAt position and distanceAheadMeters
            else if (marker.detectedAt && marker.detectedAt.latitude && marker.detectedAt.longitude && marker.distanceAheadMeters !== undefined) {
                const nearestIndex = findNearestCoordinateIndex(
                    coordinates,
                    marker.detectedAt.latitude,
                    marker.detectedAt.longitude
                );

                const position = followRoutePath(
                    coordinates,
                    nearestIndex,
                    marker.distanceAheadMeters
                );

                marker.latitude = position.latitude;
                marker.longitude = position.longitude;
                marker.calculationMethod = 'detectedAt';
                results.method2Count++;
            }
            else {
                marker.calculationMethod = 'none';
                results.errorCount++;
            }
        } catch (error) {
            console.error(`Error processing marker ${marker.stationName}:`, error.message);
            marker.calculationMethod = 'error';
            results.errorCount++;
        }
    }

    return results;
}

/**
 * Normalize platform/track naming for consistent matching
 * Converts "Track X" to "Platform X" for matching purposes
 */
function normalizePlatformName(name) {
    if (!name) return name;
    // Replace "Track" with "Platform" for consistent matching (case insensitive)
    return name.replace(/\bTrack\b/gi, 'Platform');
}

/**
 * Map timetable entries to marker coordinates using apiName matching
 * Treats "Platform" and "Track" as interchangeable for matching
 * Returns updated timetable entries with coordinates
 */
function mapTimetableToMarkers(timetableEntries, markers) {
    const markerMap = new Map();

    // Build a map of marker names to coordinates
    // Normalize names to treat Platform/Track interchangeably
    for (const marker of markers) {
        if (marker.latitude && marker.longitude) {
            const normalizedName = normalizePlatformName(marker.stationName);
            markerMap.set(normalizedName, {
                latitude: marker.latitude,
                longitude: marker.longitude
            });
            // Also store original if different (for exact matches)
            if (normalizedName !== marker.stationName) {
                markerMap.set(marker.stationName, {
                    latitude: marker.latitude,
                    longitude: marker.longitude
                });
            }
        }
    }

    // Map coordinates to timetable entries using apiName matching
    for (const entry of timetableEntries) {
        // Skip if entry already has user-entered coordinates
        if (entry.latitude && entry.longitude) {
            continue;
        }

        // Skip if no apiName - only entries with valid apiName can get coordinates
        if (!entry.apiName || !entry.apiName.trim()) {
            continue;
        }

        // Try exact match first, then normalized match
        let coords = markerMap.get(entry.apiName);
        if (!coords) {
            const normalizedApiName = normalizePlatformName(entry.apiName);
            coords = markerMap.get(normalizedApiName);
        }

        if (coords) {
            entry.latitude = coords.latitude;
            entry.longitude = coords.longitude;
        }
    }

    return timetableEntries;
}

/**
 * Process a timetable's recording data
 * This calculates marker positions and maps them to timetable entries
 */
async function processRecordingData(req, res) {
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
            sendJson(res, { error: 'Timetable not found' }, 404);
            return;
        }

        // Get coordinates
        const coordinates = timetableCoordinateDb.getByTimetableId(timetableId);
        if (!coordinates || coordinates.length === 0) {
            sendJson(res, { error: 'No coordinates found for this timetable' }, 400);
            return;
        }

        // Get markers
        const markers = timetableMarkerDb.getByTimetableId(timetableId);

        // Get timetable entries
        const entries = entryDb.getByTimetableId(timetableId);

        console.log(`Processing timetable ${timetableId}: ${timetable.service_name}`);
        console.log(`  Coordinates: ${coordinates.length}`);
        console.log(`  Markers: ${markers.length}`);
        console.log(`  Entries: ${entries.length}`);

        // Calculate marker positions
        const markerResults = calculateMarkerPositions(markers, coordinates);
        console.log(`  Marker processing: ${markerResults.method1Count} onspot, ${markerResults.method2Count} detectedAt, ${markerResults.errorCount} errors`);

        // Update markers in database with calculated positions
        for (const marker of markers) {
            if (marker.latitude && marker.longitude) {
                // Update the marker in database
                timetableMarkerDb.update(marker.id, {
                    station_name: marker.station_name,
                    marker_type: marker.marker_type,
                    latitude: marker.latitude,
                    longitude: marker.longitude,
                    platform_length: marker.platform_length
                });
            }
        }

        // Load station name mapping from database
        // Gets route-specific mappings plus global mappings (route_id = NULL)
        let stationNameMapping = {};
        if (timetable.route_id) {
            stationNameMapping = stationMappingDb.getMappingObject(timetable.route_id);
            const mappingCount = Object.keys(stationNameMapping).length;
            if (mappingCount > 0) {
                console.log(`  Loaded ${mappingCount} station name mappings from database`);
            }
        } else {
            // Get global mappings only
            stationNameMapping = stationMappingDb.getMappingObject(null);
            const mappingCount = Object.keys(stationNameMapping).length;
            if (mappingCount > 0) {
                console.log(`  Loaded ${mappingCount} global station name mappings`);
            }
        }

        // Pre-process raw timetable entries into proper station entries
        // This combines WAIT FOR SERVICE + LOAD PASSENGERS, STOP + LOAD PASSENGERS, etc.
        // and generates apiName from station mapping
        const timetableEntries = preprocessTimetableEntries(entries, stationNameMapping);
        console.log(`  Preprocessed ${entries.length} raw entries into ${timetableEntries.length} station entries`);

        // Preserve any user-entered coordinates from original entries
        // Match by destination/location since indices may differ after preprocessing
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

        // Map timetable entries to marker coordinates (EXACT apiName matching only)
        const processedMarkers = markers.map(m => ({
            stationName: m.station_name,
            latitude: m.latitude,
            longitude: m.longitude
        }));

        mapTimetableToMarkers(timetableEntries, processedMarkers);

        // Log apiName matching results for debugging
        let matchedCount = 0;
        let unmatchedEntries = [];
        for (const entry of timetableEntries) {
            if (entry.latitude && entry.longitude) {
                matchedCount++;
            } else if (entry.apiName) {
                unmatchedEntries.push({ destination: entry.destination, apiName: entry.apiName });
            }
        }
        console.log(`  Coordinate matching: ${matchedCount} matched, ${unmatchedEntries.length} with apiName but no match`);
        if (unmatchedEntries.length > 0 && unmatchedEntries.length <= 5) {
            console.log(`    Unmatched apiNames: ${unmatchedEntries.map(e => e.apiName).join(', ')}`);
        }

        // Note: We don't update the original entries in database here
        // The preprocessed entries are used for export/display only
        // Raw entries are preserved in the database for flexibility
        console.log(`  Preprocessed timetable ready for export`);

        sendJson(res, {
            success: true,
            timetableId,
            serviceName: timetable.service_name,
            coordinateCount: coordinates.length,
            markerCount: markers.length,
            rawEntryCount: entries.length,
            processedEntryCount: timetableEntries.length,
            markerProcessing: markerResults,
            entriesMatched: matchedCount,
            entriesUnmatched: unmatchedEntries.length
        });

    } catch (err) {
        console.error('Error processing recording data:', err);
        sendJson(res, { error: err.message }, 500);
    }
}

/**
 * Get a processed recording file from the recording_data folder
 */
function getProcessedFile(req, res, filename) {
    const recordingDir = path.join(appDir, 'recording_data');
    const filePath = path.join(recordingDir, filename);

    if (!fs.existsSync(filePath)) {
        sendJson(res, { error: 'File not found' }, 404);
        return;
    }

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        sendJson(res, data);
    } catch (err) {
        sendJson(res, { error: 'Failed to read file: ' + err.message }, 500);
    }
}

/**
 * List available recording files
 */
function listRecordingFiles(req, res) {
    const recordingDir = path.join(appDir, 'recording_data');

    if (!fs.existsSync(recordingDir)) {
        sendJson(res, { files: [] });
        return;
    }

    const files = fs.readdirSync(recordingDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const filePath = path.join(recordingDir, f);
            const stats = fs.statSync(filePath);
            return {
                filename: f,
                size: stats.size,
                modified: stats.mtime
            };
        })
        .sort((a, b) => b.modified - a.modified);

    sendJson(res, { files });
}

/**
 * Process a recording file (file-based processing)
 * Kept for backwards compatibility
 */
async function process(req, res, filename) {
    const recordingDir = path.join(appDir, 'recording_data');
    const processedDir = path.join(appDir, 'processed_data');

    // Ensure processed directory exists
    if (!fs.existsSync(processedDir)) {
        fs.mkdirSync(processedDir, { recursive: true });
    }

    if (!filename) {
        sendJson(res, { error: 'filename is required' }, 400);
        return;
    }

    const inputPath = path.join(recordingDir, filename);
    if (!fs.existsSync(inputPath)) {
        sendJson(res, { error: 'File not found' }, 404);
        return;
    }

    try {
        const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

        // Calculate marker positions if we have coordinates
        if (data.coordinates && data.coordinates.length > 0 && data.markers) {
            const results = calculateMarkerPositions(data.markers, data.coordinates);
            console.log(`Processed ${filename}: ${results.method1Count} onspot, ${results.method2Count} detectedAt, ${results.errorCount} errors`);
        }

        // Save processed file
        const outputPath = path.join(processedDir, filename);
        fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));

        sendJson(res, {
            success: true,
            filename,
            outputPath: outputPath
        });
    } catch (err) {
        console.error('Error processing file:', err);
        sendJson(res, { error: err.message }, 500);
    }
}

/**
 * List processed files
 */
function listProcessed(req, res) {
    const processedDir = path.join(appDir, 'processed_data');

    if (!fs.existsSync(processedDir)) {
        sendJson(res, { files: [] });
        return;
    }

    const files = fs.readdirSync(processedDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const filePath = path.join(processedDir, f);
            const stats = fs.statSync(filePath);
            return {
                filename: f,
                size: stats.size,
                modified: stats.mtime
            };
        })
        .sort((a, b) => b.modified - a.modified);

    sendJson(res, { files });
}

module.exports = {
    calculateDistance,
    findNearestCoordinateIndex,
    followRoutePath,
    preprocessTimetableEntries,
    calculateMarkerPositions,
    mapTimetableToMarkers,
    processRecordingData,
    getProcessedFile,
    listRecordingFiles,
    // Aliases for route compatibility
    process,
    listProcessed
};
