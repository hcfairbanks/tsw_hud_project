'use strict';
const { trainDb, trainClassDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

const trainController = {
    // GET /api/trains
    getAll: async (req, res) => {
        const trains = trainDb.getAllWithClass();
        sendJson(res, trains);
    },

    // POST /api/trains
    create: async (req, res) => {
        const body = await parseBody(req);

        // Validate required fields
        if (!body.class_id) {
            return sendJson(res, { error: 'A train must have a class. Please select a train class.' }, 400);
        }

        // Check if train name already exists
        const existing = trainDb.getByName(body.name);
        if (existing) {
            return sendJson(res, { error: 'A train with this name already exists' }, 409);
        }

        // Verify the class exists
        const trainClass = trainClassDb.getById(body.class_id);
        if (!trainClass) {
            return sendJson(res, { error: 'The specified train class does not exist' }, 400);
        }

        const result = trainDb.create(body.name, body.class_id);
        sendJson(res, { id: result.lastInsertRowid, name: body.name, class_id: body.class_id }, 201);
    },

    // GET /api/trains/:id
    getById: async (req, res, id) => {
        const train = trainDb.getByIdWithClass(id);
        if (train) {
            sendJson(res, train);
        } else {
            sendJson(res, { error: 'Train not found' }, 404);
        }
    },

    // PUT /api/trains/:id
    update: async (req, res, id) => {
        const body = await parseBody(req);

        const train = trainDb.getById(id);
        if (!train) {
            return sendJson(res, { error: 'Train not found' }, 404);
        }

        // Check if another train with this name already exists (excluding current train)
        if (body.name) {
            const existing = trainDb.getByName(body.name);
            if (existing && existing.id !== parseInt(id)) {
                return sendJson(res, { error: 'A train with this name already exists' }, 409);
            }
        }

        const name = body.name || train.name;
        const classId = body.class_id !== undefined ? body.class_id : train.class_id;

        // Validate that train still has a class
        if (!classId) {
            return sendJson(res, { error: 'A train must have a class. Please select a train class.' }, 400);
        }

        // Verify the class exists
        const trainClass = trainClassDb.getById(classId);
        if (!trainClass) {
            return sendJson(res, { error: 'The specified train class does not exist' }, 400);
        }

        trainDb.update(id, name, classId);
        sendJson(res, { id: parseInt(id), name, class_id: classId });
    },

    // DELETE /api/trains/:id
    delete: async (req, res, id) => {
        trainDb.delete(id);
        sendJson(res, { success: true });
    },

    // GET /api/trains/:id/routes
    getRoutes: async (req, res, trainId) => {
        const routes = trainDb.getRoutes(trainId);
        sendJson(res, routes);
    }
};

module.exports = trainController;
