'use strict';
const { sendJson } = require('../utils/http');
const { timetableDb, timetableDataDb, timetableCoordinateDb, timetableMarkerDb } = require('../db');

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
                coordinateCount = timetableCoordinateDb.bulkInsert(timetableId, recordingData.coordinates);
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

module.exports = {
    getAllTimetables,
    getTimetablesWithData,
    getTimetableData,
    importFromRecording
};
