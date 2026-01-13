'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson } = require('../utils/http');

// Directories
const recordingDataDir = path.join(__dirname, '..', 'recording_data');
const processedRoutesDir = path.join(__dirname, '..', 'processed_routes');

// Ensure processed_routes directory exists
if (!fs.existsSync(processedRoutesDir)) {
    fs.mkdirSync(processedRoutesDir, { recursive: true });
}

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

    const coordinates = rawData.coordinates || [];
    const markers = rawData.markers || [];
    const timetable = rawData.timetable || [];

    // Process markers - calculate positions and clean up
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

    // Match markers to timetable entries by stationName -> apiName
    // Only fill in coordinates if timetable entry doesn't already have them
    const processedTimetable = timetable.map(entry => {
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
                console.log(`  Matched timetable "${entry.destination}" (${entry.apiName}) -> marker "${matchingMarker.stationName}"`);
            }
        } else {
            console.log(`  Timetable "${entry.destination}" already has coordinates`);
        }

        return result;
    });

    // Simplify coordinates to reduce file size while preserving path accuracy
    // Epsilon of 1 meter means points within 1m of the simplified line are removed
    const SIMPLIFY_EPSILON = 1; // meters
    const simplifiedCoordinates = simplifyPath(coordinates, SIMPLIFY_EPSILON);
    console.log(`  Simplified coordinates: ${coordinates.length} -> ${simplifiedCoordinates.length} (${((1 - simplifiedCoordinates.length / coordinates.length) * 100).toFixed(1)}% reduction)`);

    // Build processed output
    const processed = {
        routeName: rawData.routeName,
        timetableId: rawData.timetableId,
        totalPoints: simplifiedCoordinates.length,
        coordinates: simplifiedCoordinates,
        markers: processedMarkers,
        timetable: processedTimetable
    };

    return processed;
}

/**
 * Process a raw recording file and save to processed_routes
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

    // Generate output filename
    const outputFilename = inputFilename.replace('raw_data_', 'processed_');
    const outputPath = path.join(processedRoutesDir, outputFilename);

    // Write processed data
    fs.writeFileSync(outputPath, JSON.stringify(processedData, null, 2));
    console.log(`  Saved processed file: ${outputFilename}`);

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
