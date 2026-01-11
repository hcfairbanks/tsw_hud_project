'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson } = require('../utils/http');
const { timetableDb, entryDb } = require('../db');

// Recording data directory
const recordingDataDir = path.join(__dirname, '..', 'recording_data');
const processedDataDir = path.join(__dirname, '..', 'processed_data');

/**
 * Calculate distance between two lat/lng points using Haversine formula
 * Returns distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Follow the route path from a starting coordinate index for a specified distance
 * Returns {latitude, longitude} of the point on the route that is distance meters ahead
 */
function followRoutePath(coordinates, startIndex, distanceMeters) {
    if (startIndex >= coordinates.length - 1) {
        const lastCoord = coordinates[coordinates.length - 1];
        return {
            latitude: lastCoord.latitude,
            longitude: lastCoord.longitude
        };
    }

    let remainingDistance = distanceMeters;
    let currentIndex = startIndex;

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
            // The target point is within this segment - interpolate
            const ratio = remainingDistance / segmentDistance;
            return {
                latitude: current.latitude + (next.latitude - current.latitude) * ratio,
                longitude: current.longitude + (next.longitude - current.longitude) * ratio
            };
        }

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
 * Process markers and calculate their actual positions
 */
function processMarkers(data, timetableStations) {
    if (!data.coordinates || !Array.isArray(data.coordinates) || data.coordinates.length === 0) {
        return { method1Count: 0, method2Count: 0, errorCount: 0 };
    }

    if (!data.markers || !Array.isArray(data.markers)) {
        return { method1Count: 0, method2Count: 0, errorCount: 0 };
    }

    let method1Count = 0;
    let method2Count = 0;
    let errorCount = 0;

    for (let i = 0; i < data.markers.length; i++) {
        const marker = data.markers[i];
        const markerName = marker.stationName || marker.markerName || `Marker ${i + 1}`;

        // Check if this marker is a timetable station
        marker.isTimetableStation = timetableStations.includes(marker.stationName);

        try {
            // Method 1: Use onspot position and spoton_distance
            if (marker.onspot_latitude && marker.onspot_longitude && marker.spoton_distance !== undefined) {
                const nearestIndex = findNearestCoordinateIndex(
                    data.coordinates,
                    marker.onspot_latitude,
                    marker.onspot_longitude
                );

                const position = followRoutePath(
                    data.coordinates,
                    nearestIndex,
                    marker.spoton_distance
                );

                marker.latitude = position.latitude;
                marker.longitude = position.longitude;
                marker.calculationMethod = 'onspot';
                method1Count++;
            }
            // Method 2: Use detectedAt position and distanceAheadMeters
            else if (marker.detectedAt && marker.detectedAt.latitude && marker.detectedAt.longitude && marker.distanceAheadMeters !== undefined) {
                const nearestIndex = findNearestCoordinateIndex(
                    data.coordinates,
                    marker.detectedAt.latitude,
                    marker.detectedAt.longitude
                );

                const position = followRoutePath(
                    data.coordinates,
                    nearestIndex,
                    marker.distanceAheadMeters
                );

                marker.latitude = position.latitude;
                marker.longitude = position.longitude;
                marker.calculationMethod = 'detectedAt';
                method2Count++;
            }
            else {
                marker.calculationMethod = 'none';
                errorCount++;
            }
        } catch (error) {
            marker.calculationMethod = 'error';
            errorCount++;
        }

        // Clean up unnecessary fields
        delete marker.detectedAt;
        delete marker.distanceAheadMeters;
        delete marker.timestamp;
        delete marker.platformLength;
        delete marker.calculationMethod;
        delete marker.onspot_latitude;
        delete marker.onspot_longitude;
        delete marker.onspot_timestamp;
        delete marker.spoton_distance;
    }

    return { method1Count, method2Count, errorCount };
}

/**
 * Process a recording file
 */
function processRecordingFile(inputPath, outputPath) {
    const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

    // Get timetable station names
    let timetableStations = [];
    if (data.timetable && Array.isArray(data.timetable)) {
        timetableStations = data.timetable.map(stop => stop.apiName || stop.destination).filter(name => name);
    }

    // Process markers
    const result = processMarkers(data, timetableStations);

    // Clean up processing metadata
    delete data.markersProcessed;
    delete data.markersProcessedTimestamp;
    delete data.processingVersion;

    // Write output file
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));

    return {
        success: true,
        routeName: data.routeName,
        coordinateCount: data.coordinates ? data.coordinates.length : 0,
        markerCount: data.markers ? data.markers.length : 0,
        ...result
    };
}

/**
 * Process a recording and update timetable entries with calculated coordinates
 */
async function process(req, res, filename) {
    if (!filename) {
        sendJson(res, { error: 'Filename is required' }, 400);
        return;
    }

    const inputPath = path.join(recordingDataDir, filename);
    if (!fs.existsSync(inputPath)) {
        sendJson(res, { error: 'Recording file not found' }, 404);
        return;
    }

    // Create processed data directory if it doesn't exist
    if (!fs.existsSync(processedDataDir)) {
        fs.mkdirSync(processedDataDir, { recursive: true });
    }

    // Generate output filename
    const outputFilename = filename.replace('raw_data_', '');
    const outputPath = path.join(processedDataDir, outputFilename);

    try {
        const result = processRecordingFile(inputPath, outputPath);

        // If there's a timetableId, update the database entries with calculated coordinates
        const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        if (data.timetableId && data.markers) {
            const entries = entryDb.getByTimetableId(data.timetableId);

            for (const marker of data.markers) {
                if (marker.latitude && marker.longitude && marker.isTimetableStation) {
                    // Find matching entry
                    const entry = entries.find(e =>
                        e.location === marker.stationName ||
                        e.details === marker.stationName
                    );
                    if (entry && (!entry.latitude || !entry.longitude)) {
                        entry.latitude = marker.latitude.toString();
                        entry.longitude = marker.longitude.toString();
                        entryDb.update(entry.id, entry);
                    }
                }
            }
        }

        sendJson(res, {
            ...result,
            inputFile: filename,
            outputFile: outputFilename
        });
    } catch (err) {
        sendJson(res, { error: 'Processing failed: ' + err.message }, 500);
    }
}

/**
 * List processed files
 */
function listProcessed(req, res) {
    if (!fs.existsSync(processedDataDir)) {
        sendJson(res, []);
        return;
    }

    const files = fs.readdirSync(processedDataDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const filePath = path.join(processedDataDir, f);
            const stats = fs.statSync(filePath);
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                return {
                    filename: f,
                    routeName: data.routeName || 'Unknown',
                    timetableId: data.timetableId,
                    coordinateCount: data.coordinates?.length || 0,
                    markerCount: data.markers?.length || 0,
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
 * Get a specific processed file
 */
function getProcessedFile(req, res, filename) {
    if (!filename) {
        sendJson(res, { error: 'Filename is required' }, 400);
        return;
    }

    const filePath = path.join(processedDataDir, filename);
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

module.exports = {
    process,
    listProcessed,
    getProcessedFile,
    calculateDistance,
    followRoutePath,
    findNearestCoordinateIndex
};
