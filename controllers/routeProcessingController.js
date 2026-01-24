'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson } = require('../utils/http');
const { loadConfig } = require('./configController');

// Directories
const recordingDataDir = path.join(__dirname, '..', 'recording_data');
const processedRoutesDir = path.join(__dirname, '..', 'processed_routes');

// Stop detection configuration
const STOP_DETECTION_CONFIG = {
    MIN_STOP_DURATION_MS: 30000,    // 30 seconds minimum to consider a stop
    GPS_NOISE_RADIUS_METERS: 10,    // Max distance for "same location"
    MIN_POINTS_FOR_STOP: 10         // Minimum coordinate points to form valid stop
};

/**
 * Calculate distance between two lat/lng points using Haversine formula
 * Returns distance in meters
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Calculate perpendicular distance from a point to a line segment
 * Used by the Douglas-Peucker algorithm
 */
function perpendicularDistance(point, lineStart, lineEnd) {
    const x = point.latitude;
    const y = point.longitude;
    const x1 = lineStart.latitude;
    const y1 = lineStart.longitude;
    const x2 = lineEnd.latitude;
    const y2 = lineEnd.longitude;

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;

    let param = -1;
    if (lenSq !== 0) {
        param = dot / lenSq;
    }

    let xx, yy;
    if (param < 0) {
        xx = x1;
        yy = y1;
    } else if (param > 1) {
        xx = x2;
        yy = y2;
    } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
    }

    // Convert to meters for meaningful epsilon comparison
    return haversineDistance(x, y, xx, yy);
}

/**
 * Ramer-Douglas-Peucker algorithm for simplifying a path
 * Reduces the number of points while preserving the shape
 * @param {Array} points - Array of coordinate objects with latitude/longitude
 * @param {number} epsilon - Maximum distance in meters a point can deviate from the simplified line
 * @returns {Array} Simplified array of coordinates
 */
function simplifyPath(points, epsilon) {
    if (points.length < 3) {
        return points;
    }

    // Find the point with the maximum distance from the line between first and last
    let maxDistance = 0;
    let maxIndex = 0;

    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
        const distance = perpendicularDistance(points[i], firstPoint, lastPoint);
        if (distance > maxDistance) {
            maxDistance = distance;
            maxIndex = i;
        }
    }

    // If max distance is greater than epsilon, recursively simplify
    if (maxDistance > epsilon) {
        const left = simplifyPath(points.slice(0, maxIndex + 1), epsilon);
        const right = simplifyPath(points.slice(maxIndex), epsilon);

        // Combine results (remove duplicate point at junction)
        return left.slice(0, -1).concat(right);
    } else {
        // All points between first and last are within epsilon, keep only endpoints
        return [firstPoint, lastPoint];
    }
}

/**
 * Find the coordinate index closest to a given lat/lng
 */
function findClosestCoordinateIndex(coordinates, lat, lng) {
    let closestIndex = 0;
    let closestDistance = Infinity;

    for (let i = 0; i < coordinates.length; i++) {
        const coord = coordinates[i];
        const distance = haversineDistance(lat, lng, coord.latitude, coord.longitude);
        if (distance < closestDistance) {
            closestDistance = distance;
            closestIndex = i;
        }
    }

    return { index: closestIndex, distance: closestDistance };
}

/**
 * Travel along coordinates from a starting index for a given distance
 * Returns the lat/lng at the target distance
 */
function travelAlongPath(coordinates, startIndex, targetDistanceMeters) {
    let traveledDistance = 0;
    let currentIndex = startIndex;

    // Travel forward along the path
    while (currentIndex < coordinates.length - 1 && traveledDistance < targetDistanceMeters) {
        const current = coordinates[currentIndex];
        const next = coordinates[currentIndex + 1];
        const segmentDistance = haversineDistance(
            current.latitude, current.longitude,
            next.latitude, next.longitude
        );

        if (traveledDistance + segmentDistance >= targetDistanceMeters) {
            // Target is within this segment - interpolate
            const remainingDistance = targetDistanceMeters - traveledDistance;
            const ratio = remainingDistance / segmentDistance;

            return {
                latitude: current.latitude + (next.latitude - current.latitude) * ratio,
                longitude: current.longitude + (next.longitude - current.longitude) * ratio
            };
        }

        traveledDistance += segmentDistance;
        currentIndex++;
    }

    // If we've reached the end, return the last coordinate
    if (currentIndex >= coordinates.length) {
        currentIndex = coordinates.length - 1;
    }

    return {
        latitude: coordinates[currentIndex].latitude,
        longitude: coordinates[currentIndex].longitude
    };
}

/**
 * Detect stops in coordinate data based on timestamps and spatial clustering
 * Uses a rolling centroid approach to handle GPS drift better
 *
 * @param {Array} coordinates - Array of coordinate objects with latitude, longitude, timestamp
 * @param {Object} config - Stop detection configuration
 * @returns {Array} Array of detected stops with centroid positions
 */
function detectStops(coordinates, config = STOP_DETECTION_CONFIG) {
    if (!coordinates || coordinates.length < config.MIN_POINTS_FOR_STOP) {
        return [];
    }

    // Filter coordinates that have timestamps
    const coordsWithTime = coordinates.filter(c => c.timestamp);
    if (coordsWithTime.length < config.MIN_POINTS_FOR_STOP) {
        console.log('  Stop detection: Not enough coordinates with timestamps');
        return [];
    }

    const coordsWithoutTime = coordinates.length - coordsWithTime.length;
    console.log(`  Stop detection: Analyzing ${coordsWithTime.length} coordinates with timestamps`);
    if (coordsWithoutTime > 0) {
        console.log(`  WARNING: ${coordsWithoutTime} coordinates have NO timestamp (stop detection won't work on these)`);
    }

    const detectedStops = [];
    let i = 0;

    while (i < coordsWithTime.length) {
        // Start a potential stop group
        let groupCoords = [coordsWithTime[i]];
        let sumLat = coordsWithTime[i].latitude;
        let sumLng = coordsWithTime[i].longitude;

        // Try to extend the group using a rolling centroid approach
        for (let j = i + 1; j < coordsWithTime.length; j++) {
            const coord = coordsWithTime[j];

            // Calculate centroid of current group
            const centroidLat = sumLat / groupCoords.length;
            const centroidLng = sumLng / groupCoords.length;

            // Check if this coordinate is within noise radius of the centroid
            const distFromCentroid = haversineDistance(
                centroidLat, centroidLng,
                coord.latitude, coord.longitude
            );

            // Use a slightly larger radius (2x) to account for GPS drift
            if (distFromCentroid <= config.GPS_NOISE_RADIUS_METERS * 2) {
                groupCoords.push(coord);
                sumLat += coord.latitude;
                sumLng += coord.longitude;
            } else {
                // Point is too far from centroid, stop extending
                break;
            }
        }

        // Check if this group forms a valid stop
        if (groupCoords.length >= config.MIN_POINTS_FOR_STOP) {
            const startTime = new Date(groupCoords[0].timestamp);
            const endTime = new Date(groupCoords[groupCoords.length - 1].timestamp);
            const durationMs = endTime - startTime;

            if (durationMs >= config.MIN_STOP_DURATION_MS) {
                const centroid = {
                    latitude: sumLat / groupCoords.length,
                    longitude: sumLng / groupCoords.length
                };

                detectedStops.push({
                    startIndex: i,
                    endIndex: i + groupCoords.length - 1,
                    startTime: groupCoords[0].timestamp,
                    endTime: groupCoords[groupCoords.length - 1].timestamp,
                    durationSeconds: Math.round(durationMs / 1000),
                    centroid: centroid,
                    pointCount: groupCoords.length
                });

                console.log(`  Detected stop: ${Math.round(durationMs / 1000)}s at (${centroid.latitude.toFixed(6)}, ${centroid.longitude.toFixed(6)}) [${groupCoords.length} points]`);

                // Skip past this stop
                i += groupCoords.length;
                continue;
            }
        }

        // Move to next coordinate
        i++;
    }

    console.log(`\n  === DETECTED STOPS SUMMARY ===`);
    console.log(`  Total stops found: ${detectedStops.length}`);
    console.log(`  Threshold: ${config.MIN_STOP_DURATION_MS / 1000}s minimum duration`);
    detectedStops.forEach((stop, idx) => {
        console.log(`  Stop ${idx}: ${stop.durationSeconds}s at (${stop.centroid.latitude.toFixed(6)}, ${stop.centroid.longitude.toFixed(6)})`);
    });
    console.log(`  ==============================\n`);
    return detectedStops;
}

/**
 * Match detected stops to timetable entries that are missing coordinates
 * Uses proximity matching: for each entry without coords, find the nearest unmatched stop.
 * Stops are consumed in order (can't skip back) to maintain route progression.
 *
 * @param {Array} detectedStops - Array of detected stops from detectStops()
 * @param {Array} timetable - Array of timetable entries
 * @returns {Array} Updated timetable with coordinates filled in from detected stops
 */
function matchStopsToTimetable(detectedStops, timetable) {
    if (!detectedStops || detectedStops.length === 0 || !timetable || timetable.length === 0) {
        return timetable;
    }

    console.log(`\n  === TIMETABLE INPUT STATUS ===`);
    const entriesWithCoords = timetable.filter(e => e.latitude != null && e.longitude != null);
    const entriesWithoutCoords = timetable.filter(e => e.latitude == null || e.longitude == null);
    console.log(`  Entries WITH coordinates: ${entriesWithCoords.length}`);
    entriesWithCoords.forEach((e, i) => {
        const idx = timetable.indexOf(e);
        console.log(`    [${idx}] ${e.location}: ${e.latitude?.toFixed(6)}, ${e.longitude?.toFixed(6)}`);
    });
    console.log(`  Entries WITHOUT coordinates: ${entriesWithoutCoords.length}`);
    entriesWithoutCoords.forEach((e, i) => {
        const idx = timetable.indexOf(e);
        console.log(`    [${idx}] ${e.location}`);
    });
    console.log(`  ==============================\n`);

    console.log(`  Matching ${detectedStops.length} detected stops to ${entriesWithoutCoords.length} entries needing coordinates`);

    // Track which stops have been used and store match info
    const usedStops = new Set();
    const entryMatchInfo = new Map(); // entryIndex -> { stopIdx, distance, stop }

    // For entries WITH coordinates, find and mark the closest stop as "used"
    // This ensures we don't assign that stop to a different entry
    timetable.forEach((entry, entryIndex) => {
        if (entry.latitude != null && entry.longitude != null) {
            let bestStopIdx = -1;
            let bestDist = Infinity;

            for (let stopIdx = 0; stopIdx < detectedStops.length; stopIdx++) {
                if (usedStops.has(stopIdx)) continue;

                const stop = detectedStops[stopIdx];
                const dist = haversineDistance(
                    entry.latitude, entry.longitude,
                    stop.centroid.latitude, stop.centroid.longitude
                );

                // Must be within 250m to be considered a match
                if (dist < bestDist && dist < 250) {
                    bestDist = dist;
                    bestStopIdx = stopIdx;
                }
            }

            if (bestStopIdx >= 0) {
                usedStops.add(bestStopIdx);
                entryMatchInfo.set(entryIndex, {
                    stopIdx: bestStopIdx,
                    distance: Math.round(bestDist),
                    stop: detectedStops[bestStopIdx]
                });
                console.log(`  Entry ${entryIndex} "${entry.location}": Has coords, matched to stop ${bestStopIdx} (${Math.round(bestDist)}m away)`);
            } else {
                console.log(`  Entry ${entryIndex} "${entry.location}": Has coords, no nearby stop found`);
            }
        }
    });

    // Now match entries WITHOUT coordinates to remaining stops
    // Process in order, assigning the first available (unused) stop
    let nextAvailableStopIdx = 0;

    const updatedTimetable = timetable.map((entry, entryIndex) => {
        const result = { ...entry };

        // For entries that already have coordinates, add the match distance info
        if (entry.latitude != null && entry.longitude != null) {
            const matchInfo = entryMatchInfo.get(entryIndex);
            if (matchInfo) {
                result._matchedStopDistance = matchInfo.distance;
                result._stopDurationSeconds = matchInfo.stop.durationSeconds;
            }
            return result;
        }

        // Find the next unused stop
        while (nextAvailableStopIdx < detectedStops.length && usedStops.has(nextAvailableStopIdx)) {
            nextAvailableStopIdx++;
        }

        if (nextAvailableStopIdx >= detectedStops.length) {
            console.log(`  Entry ${entryIndex} "${entry.location}": No more stops available`);
            return result;
        }

        const stop = detectedStops[nextAvailableStopIdx];
        usedStops.add(nextAvailableStopIdx);

        // Match this entry to the stop
        result.latitude = stop.centroid.latitude;
        result.longitude = stop.centroid.longitude;
        result._autoDetected = true;
        result._stopDurationSeconds = stop.durationSeconds;

        console.log(`  Entry ${entryIndex} "${entry.location}": Auto-matched to stop ${nextAvailableStopIdx} at (${stop.centroid.latitude.toFixed(6)}, ${stop.centroid.longitude.toFixed(6)}) [${stop.durationSeconds}s]`);

        nextAvailableStopIdx++;
        return result;
    });

    // Log summary of matching
    console.log(`\n  === STOP MATCHING SUMMARY ===`);
    console.log(`  Stops used: ${usedStops.size}/${detectedStops.length}`);
    const unusedCount = detectedStops.length - usedStops.size;
    if (unusedCount > 0) {
        console.log(`  Unused stops: ${unusedCount}`);
        for (let i = 0; i < detectedStops.length; i++) {
            if (!usedStops.has(i)) {
                const stop = detectedStops[i];
                console.log(`    - Stop ${i}: ${stop.durationSeconds}s at (${stop.centroid.latitude.toFixed(6)}, ${stop.centroid.longitude.toFixed(6)})`);
            }
        }
    }
    console.log(`  =============================\n`);

    return updatedTimetable;
}

/**
 * Calculate marker position from raw data
 * Uses onspot_* data if available, otherwise falls back to detectedAt
 */
function calculateMarkerPosition(marker, coordinates) {
    let startLat, startLng, distanceMeters;

    // Prefer onspot_* data (more accurate - closer to marker)
    if (marker.onspot_latitude != null && marker.onspot_longitude != null && marker.onspot_distance != null) {
        startLat = marker.onspot_latitude;
        startLng = marker.onspot_longitude;
        distanceMeters = marker.onspot_distance;
    }
    // Fall back to detectedAt data
    else if (marker.detectedAt && marker.distanceAheadMeters != null) {
        startLat = marker.detectedAt.latitude;
        startLng = marker.detectedAt.longitude;
        distanceMeters = marker.distanceAheadMeters;
    }
    else {
        // No position data available
        console.log(`  Warning: No position data for marker "${marker.stationName}"`);
        return null;
    }

    // Find the closest coordinate to the starting position
    const { index: startIndex } = findClosestCoordinateIndex(coordinates, startLat, startLng);

    // Travel along the path for the specified distance
    const position = travelAlongPath(coordinates, startIndex, distanceMeters);

    console.log(`  Marker "${marker.stationName}": start=(${startLat.toFixed(6)}, ${startLng.toFixed(6)}), ` +
                `distance=${distanceMeters.toFixed(1)}m -> position=(${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)})`);

    return position;
}

/**
 * Process raw recording data and calculate marker positions
 */
function processRawData(rawData) {
    console.log(`Processing route: ${rawData.routeName}`);
    console.log(`  Coordinates: ${rawData.coordinates?.length || 0}`);
    console.log(`  Markers: ${rawData.markers?.length || 0}`);
    console.log(`  Timetable entries: ${rawData.timetable?.length || 0}`);
    console.log(`  Recording mode: ${rawData.recordingMode || 'unknown'}`);

    const coordinates = rawData.coordinates || [];
    const markers = rawData.markers || [];
    const timetable = rawData.timetable || [];
    const isAutomatic = rawData.recordingMode === 'automatic';

    // Step 1: Process markers - calculate positions and clean up
    const processedMarkers = markers.map(marker => {
        const position = calculateMarkerPosition(marker, coordinates);

        // Create clean marker object (without detection data)
        const cleanMarker = {
            stationName: marker.stationName,
            markerType: marker.markerType
        };

        // Keep platformLength if it exists
        if (marker.platformLength != null) {
            cleanMarker.platformLength = marker.platformLength;
        }

        // Add calculated position
        if (position) {
            cleanMarker.latitude = position.latitude;
            cleanMarker.longitude = position.longitude;
        }

        return cleanMarker;
    });

    // Step 2: Detect stops (ONLY if automatic mode)
    // This must happen while we have all the dense coordinate data (before simplification)
    let detectedStops = [];
    if (isAutomatic) {
        console.log('\n  Automatic mode: Running stop detection...');
        detectedStops = detectStops(coordinates, STOP_DETECTION_CONFIG);
    } else {
        console.log('\n  Manual mode: Skipping stop detection');
    }

    // Step 3: Match detected stops to timetable entries (ONLY if automatic mode)
    // This runs FIRST so stop detection has priority over marker matching
    // Only fill in coordinates if timetable entry doesn't already have them
    let processedTimetable = timetable.map(entry => ({ ...entry }));

    if (isAutomatic && detectedStops.length > 0) {
        processedTimetable = matchStopsToTimetable(detectedStops, processedTimetable);
    }

    // Step 4: Simplify coordinates to reduce file size while preserving path accuracy
    // Epsilon of 1 meter means points within 1m of the simplified line are removed
    // This happens AFTER stop detection so we have full data for stop analysis
    const SIMPLIFY_EPSILON = 1; // meters
    const simplifiedCoordinates = simplifyPath(coordinates, SIMPLIFY_EPSILON);
    console.log(`  Simplified coordinates: ${coordinates.length} -> ${simplifiedCoordinates.length} (${((1 - simplifiedCoordinates.length / coordinates.length) * 100).toFixed(1)}% reduction)`);

    // Step 5: In automatic mode, if the LAST timetable entry still has no coordinates,
    // use the very last coordinate from the simplified path (accounts for GPS drift).
    // This handles the case where the final stop was less than 30 seconds.
    if (isAutomatic && processedTimetable.length > 0 && simplifiedCoordinates.length > 0) {
        const lastEntryIdx = processedTimetable.length - 1;
        const lastEntry = processedTimetable[lastEntryIdx];

        // Only fill in if no coordinates exist (don't overwrite user-entered data)
        if (lastEntry.latitude == null || lastEntry.longitude == null) {
            const lastCoord = simplifiedCoordinates[simplifiedCoordinates.length - 1];
            if (lastCoord && lastCoord.latitude != null && lastCoord.longitude != null) {
                processedTimetable[lastEntryIdx] = {
                    ...lastEntry,
                    latitude: lastCoord.latitude,
                    longitude: lastCoord.longitude,
                    _autoDetected: true,
                    _usedLastCoordinate: true
                };
                console.log(`  Final entry "${lastEntry.location}": Used last path coordinate (${lastCoord.latitude.toFixed(6)}, ${lastCoord.longitude.toFixed(6)})`);
            }
        }
    }

    // Step 6: Match markers to timetable entries by stationName -> apiName
    // Only used in MANUAL mode - automatic mode uses stop detection only
    // This is a fallback for entries that weren't matched by stop detection
    if (!isAutomatic) {
        console.log('\n  Manual mode: Using marker matching for coordinates');
        processedTimetable = processedTimetable.map(entry => {
            const result = { ...entry };

            // Check if this entry needs coordinates
            const hasCoords = entry.latitude != null && entry.longitude != null;
            if (!hasCoords) {
                // Look for a marker that matches this entry's apiName
                // apiName format is typically "StationName PlatformNumber" (e.g., "Metro South 1")
                // Marker stationName is just "Metro South"
                const matchingMarker = processedMarkers.find(m => {
                    // Check if apiName starts with marker stationName
                    return entry.apiName && m.stationName &&
                           entry.apiName.startsWith(m.stationName) &&
                           m.latitude != null && m.longitude != null;
                });

                if (matchingMarker) {
                    result.latitude = matchingMarker.latitude;
                    result.longitude = matchingMarker.longitude;
                    console.log(`  Matched timetable "${entry.location}" (${entry.apiName}) -> marker "${matchingMarker.stationName}"`);
                }
            } else {
                console.log(`  Timetable "${entry.location}" already has coordinates (user-entered)`);
            }

            return result;
        });
    } else {
        console.log('\n  Automatic mode: Skipping marker matching');
    }

    // Step 5: Print final timetable status and check for missing coordinates
    console.log('\n  === TIMETABLE COORDINATE STATUS ===');
    let missingCount = 0;
    processedTimetable.forEach((entry, idx) => {
        const hasCoords = entry.latitude != null && entry.longitude != null;
        const source = entry._autoDetected ? '(auto-detected)' : (hasCoords ? '(from recording)' : '(MISSING)');
        if (hasCoords) {
            console.log(`  [${idx}] ${entry.location}: ${entry.latitude.toFixed(6)}, ${entry.longitude.toFixed(6)} ${source}`);
        } else {
            console.log(`  [${idx}] ${entry.location}: NO COORDINATES ${source}`);
            missingCount++;
        }
    });
    console.log(`  =====================================`);

    if (missingCount > 0) {
        console.log(`  WARNING: ${missingCount} timetable entries are missing coordinates!`);
    } else {
        console.log(`  All ${processedTimetable.length} timetable entries have coordinates`);
    }

    // Build processed output
    const processed = {
        routeName: rawData.routeName,
        timetableId: rawData.timetableId,
        totalPoints: simplifiedCoordinates.length,
        coordinates: simplifiedCoordinates,
        markers: processedMarkers,
        timetable: processedTimetable,
        detectedStops: detectedStops.length  // Include count for reference
    };

    return processed;
}

/**
 * Process a raw recording file (does NOT write to disk - that's done in saveProcessedJson)
 */
function processRecordingFile(inputFilename) {
    const inputPath = path.join(recordingDataDir, inputFilename);

    if (!fs.existsSync(inputPath)) {
        throw new Error(`Input file not found: ${inputFilename}`);
    }

    // Read raw data
    const rawContent = fs.readFileSync(inputPath, 'utf8');
    const rawData = JSON.parse(rawContent);

    // Process the data
    const processedData = processRawData(rawData);

    // Generate output filename (for reference, actual file writing happens in saveProcessedJson)
    const outputFilename = inputFilename.replace('raw_data_', 'processed_');
    const outputPath = path.join(processedRoutesDir, outputFilename);

    return {
        inputFile: inputFilename,
        outputFile: outputFilename,
        outputPath: outputPath,
        data: processedData
    };
}

/**
 * Get the most recent raw recording file
 */
function getMostRecentRecordingFile() {
    if (!fs.existsSync(recordingDataDir)) {
        return null;
    }

    const files = fs.readdirSync(recordingDataDir)
        .filter(f => f.startsWith('raw_data_') && f.endsWith('.json'))
        .map(f => ({
            name: f,
            time: fs.statSync(path.join(recordingDataDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

    return files.length > 0 ? files[0].name : null;
}

/**
 * API endpoint: Process the most recent recording file
 */
function processLatestRecording(req, res) {
    try {
        const filename = getMostRecentRecordingFile();
        if (!filename) {
            sendJson(res, { success: false, error: 'No recording files found' }, 404);
            return;
        }

        const result = processRecordingFile(filename);
        sendJson(res, {
            success: true,
            message: 'Recording processed successfully',
            inputFile: result.inputFile,
            outputFile: result.outputFile,
            stats: {
                coordinates: result.data.coordinates?.length || 0,
                markers: result.data.markers?.length || 0,
                timetableEntries: result.data.timetable?.length || 0
            }
        });
    } catch (err) {
        console.error('Error processing recording:', err);
        sendJson(res, { success: false, error: err.message }, 500);
    }
}

/**
 * API endpoint: List processed route files
 */
function listProcessedRoutes(req, res) {
    try {
        if (!fs.existsSync(processedRoutesDir)) {
            sendJson(res, { files: [] });
            return;
        }

        const files = fs.readdirSync(processedRoutesDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const filePath = path.join(processedRoutesDir, f);
                const stats = fs.statSync(filePath);
                return {
                    name: f,
                    size: stats.size,
                    modified: stats.mtime.toISOString()
                };
            })
            .sort((a, b) => new Date(b.modified) - new Date(a.modified));

        sendJson(res, { files });
    } catch (err) {
        console.error('Error listing processed routes:', err);
        sendJson(res, { success: false, error: err.message }, 500);
    }
}

/**
 * API endpoint: Get a specific processed route file
 */
function getProcessedRoute(req, res, filename) {
    try {
        if (!filename) {
            sendJson(res, { success: false, error: 'Filename required' }, 400);
            return;
        }

        const filePath = path.join(processedRoutesDir, filename);
        if (!fs.existsSync(filePath)) {
            sendJson(res, { success: false, error: 'File not found' }, 404);
            return;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        sendJson(res, data);
    } catch (err) {
        console.error('Error reading processed route:', err);
        sendJson(res, { success: false, error: err.message }, 500);
    }
}

module.exports = {
    processRawData,
    processRecordingFile,
    getMostRecentRecordingFile,
    processLatestRecording,
    listProcessedRoutes,
    getProcessedRoute
};
