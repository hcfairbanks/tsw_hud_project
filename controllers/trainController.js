'use strict';
const { trainDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

const trainController = {
    // GET /api/trains
    getAll: async (req, res) => {
        const trains = trainDb.getAll();
        sendJson(res, trains);
    },

    // POST /api/trains
    create: async (req, res) => {
        const body = await parseBody(req);

        // Check if train name already exists
        const existing = trainDb.getByName(body.name);
        if (existing) {
            return sendJson(res, { error: 'A train with this name already exists' }, 409);
        }

        const result = trainDb.create(body.name);
        sendJson(res, { id: result.lastInsertRowid, name: body.name }, 201);
    },

    // GET /api/trains/:id
    getById: async (req, res, id) => {
        const train = trainDb.getById(id);
        if (train) {
            sendJson(res, train);
        } else {
            sendJson(res, { error: 'Train not found' }, 404);
        }
    },

    // PUT /api/trains/:id
    update: async (req, res, id) => {
        const body = await parseBody(req);

        // Check if another train with this name already exists (excluding current train)
        const existing = trainDb.getByName(body.name);
        if (existing && existing.id !== parseInt(id)) {
            return sendJson(res, { error: 'A train with this name already exists' }, 409);
        }

        trainDb.update(id, body.name);
        sendJson(res, { id, name: body.name });
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
