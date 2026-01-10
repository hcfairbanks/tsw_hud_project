'use strict';
const { timetableDb, entryDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

const timetableController = {
    // GET /api/timetables
    getAll: async (req, res) => {
        const timetables = timetableDb.getAll();
        sendJson(res, timetables);
    },

    // POST /api/timetables
    create: async (req, res) => {
        const body = await parseBody(req);
        console.log('=== CREATE TIMETABLE ===');
        console.log('Body received:', JSON.stringify(body, null, 2));
        
        // Step 1: Create the timetable
        const serviceName = body.service_name || 'Untitled';
        const result = timetableDb.create(serviceName);
        const timetableId = result.lastInsertRowid;
        console.log('Timetable created with ID:', timetableId);
        
        // Step 2: Create all entries if provided
        const savedEntries = [];
        if (body.entries && Array.isArray(body.entries)) {
            console.log(`Creating ${body.entries.length} entries...`);
            body.entries.forEach((entry, index) => {
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
    }
};

module.exports = timetableController;
