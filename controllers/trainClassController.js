'use strict';
const { trainClassDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

const trainClassController = {
    // GET /api/train-classes
    getAll: async (req, res) => {
        const trainClasses = trainClassDb.getAll();
        sendJson(res, trainClasses);
    },

    // POST /api/train-classes
    create: async (req, res) => {
        const body = await parseBody(req);

        if (!body.name || !body.name.trim()) {
            return sendJson(res, { error: 'Name is required' }, 400);
        }

        // Check if train class name already exists
        const existing = trainClassDb.getByName(body.name);
        if (existing) {
            return sendJson(res, { error: 'A train class with this name already exists' }, 409);
        }

        const result = trainClassDb.create(body.name.trim());
        sendJson(res, { id: result.lastInsertRowid, name: body.name.trim() }, 201);
    },

    // GET /api/train-classes/:id
    getById: async (req, res, id) => {
        const trainClass = trainClassDb.getById(id);
        if (trainClass) {
            sendJson(res, trainClass);
        } else {
            sendJson(res, { error: 'Train class not found' }, 404);
        }
    },

    // PUT /api/train-classes/:id
    update: async (req, res, id) => {
        const body = await parseBody(req);

        if (!body.name || !body.name.trim()) {
            return sendJson(res, { error: 'Name is required' }, 400);
        }

        // Check if another train class with this name already exists (excluding current)
        const existing = trainClassDb.getByName(body.name);
        if (existing && existing.id !== parseInt(id)) {
            return sendJson(res, { error: 'A train class with this name already exists' }, 409);
        }

        trainClassDb.update(id, body.name.trim());
        sendJson(res, { id: parseInt(id), name: body.name.trim() });
    },

    // DELETE /api/train-classes/:id
    delete: async (req, res, id) => {
        const trainClass = trainClassDb.getById(id);
        if (!trainClass) {
            return sendJson(res, { error: 'Train class not found' }, 404);
        }

        trainClassDb.delete(id);
        sendJson(res, { success: true });
    },

    // GET /api/train-classes/:id/trains
    getTrains: async (req, res, classId) => {
        const trainClass = trainClassDb.getById(classId);
        if (!trainClass) {
            return sendJson(res, { error: 'Train class not found' }, 404);
        }

        const trains = trainClassDb.getTrains(classId);
        sendJson(res, trains);
    },

    // GET /api/train-classes/:id/routes
    getRoutes: async (req, res, classId) => {
        const trainClass = trainClassDb.getById(classId);
        if (!trainClass) {
            return sendJson(res, { error: 'Train class not found' }, 404);
        }

        const routes = trainClassDb.getRoutes(classId);
        sendJson(res, routes);
    }
};

module.exports = trainClassController;
