'use strict';
const { entryDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

const entryController = {
    // GET /api/timetables/:id/entries
    getByTimetableId: async (req, res, timetableId) => {
        console.log('=== ENTRIES API ===');
        console.log('timetableId from URL:', timetableId);
        const entries = entryDb.getByTimetableId(timetableId);
        sendJson(res, entries);
    },

    // POST /api/timetables/:id/entries
    create: async (req, res, timetableId) => {
        const body = await parseBody(req);
        console.log('Creating entry with timetableId:', timetableId);
        console.log('Entry body:', JSON.stringify(body, null, 2));
        const entries = entryDb.getByTimetableId(timetableId);
        const sortOrder = entries.length;
        const result = entryDb.create(timetableId, body, sortOrder);
        console.log('Entry created with id:', result.lastInsertRowid);
        sendJson(res, { id: result.lastInsertRowid, timetable_id: timetableId, ...body }, 201);
    },

    // PUT /api/entries/:id
    update: async (req, res, id) => {
        const body = await parseBody(req);
        console.log('=== SAVE: Updating entry ===');
        console.log('Entry ID:', id);
        console.log('Body received:', JSON.stringify(body, null, 2));
        entryDb.update(id, body);
        sendJson(res, { id, ...body });
    },

    // DELETE /api/entries/:id
    delete: async (req, res, id) => {
        entryDb.delete(id);
        sendJson(res, { success: true });
    }
};

module.exports = entryController;
