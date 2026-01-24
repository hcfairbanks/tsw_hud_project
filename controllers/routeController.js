'use strict';
const { routeDb, countryDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

const routeController = {
    // GET /api/routes
    getAll: async (req, res) => {
        const routes = routeDb.getAll();
        sendJson(res, routes);
    },

    // GET /api/routes/with-coordinates - routes that have timetables with coordinates
    getWithCoordinates: async (req, res) => {
        const routes = routeDb.getRoutesWithCoordinates();
        sendJson(res, routes);
    },

    // GET /api/routes/paginated?page=1&limit=10&search=term&country_id=1
    getPaginated: async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 10;
        const search = url.searchParams.get('search') || '';
        const countryId = url.searchParams.get('country_id') ? parseInt(url.searchParams.get('country_id')) : null;

        const result = routeDb.getPaginated(page, limit, search, countryId);
        sendJson(res, result);
    },



    // POST /api/routes
    create: async (req, res) => {
        const body = await parseBody(req);

        // Check if route name already exists
        const existing = routeDb.getByName(body.name);
        if (existing) {
            return sendJson(res, { error: 'A route with this name already exists' }, 409);
        }

        const result = routeDb.create(body.name, body.country_id, body.tsw_version || 3);
        sendJson(res, {
            id: result.lastInsertRowid,
            name: body.name,
            country_id: body.country_id,
            tsw_version: body.tsw_version || 3
        }, 201);
    },

    // GET /api/routes/:id
    getById: async (req, res, id) => {
        const route = routeDb.getById(id);
        if (route) {
            // Add country name to the response
            let countryName = null;
            if (route.country_id) {
                const country = countryDb.getById(route.country_id);
                countryName = country ? country.name : null;
            }
            sendJson(res, { ...route, country: countryName });
        } else {
            sendJson(res, { error: 'Route not found' }, 404);
        }
    },

    // PUT /api/routes/:id
    update: async (req, res, id) => {
        const body = await parseBody(req);

        // Check if another route with this name already exists (excluding current route)
        const existing = routeDb.getByName(body.name);
        if (existing && existing.id !== parseInt(id)) {
            return sendJson(res, { error: 'A route with this name already exists' }, 409);
        }

        routeDb.update(id, body.name, body.country_id, body.tsw_version);
        sendJson(res, { id, name: body.name, country_id: body.country_id, tsw_version: body.tsw_version });
    },

    // DELETE /api/routes/:id
    delete: async (req, res, id) => {
        routeDb.delete(id);
        sendJson(res, { success: true });
    },

    // GET /api/routes/:id/trains
    getTrains: async (req, res, routeId) => {
        const trains = routeDb.getTrains(routeId);
        sendJson(res, trains);
    },

    // POST /api/routes/:id/trains
    addTrain: async (req, res, routeId) => {
        const body = await parseBody(req);
        routeDb.addTrain(routeId, body.train_id);
        sendJson(res, { success: true }, 201);
    },

    // DELETE /api/routes/:id/trains
    removeTrain: async (req, res, routeId) => {
        const body = await parseBody(req);
        routeDb.removeTrain(routeId, body.train_id);
        sendJson(res, { success: true });
    },

    // GET /api/routes/:id/train-classes
    getTrainClasses: async (req, res, routeId) => {
        const trainClasses = routeDb.getTrainClasses(routeId);
        sendJson(res, trainClasses);
    },

    // POST /api/routes/:id/train-classes
    addTrainClass: async (req, res, routeId) => {
        const body = await parseBody(req);
        routeDb.addTrainClass(routeId, body.class_id);
        sendJson(res, { success: true }, 201);
    },

    // DELETE /api/routes/:id/train-classes
    removeTrainClass: async (req, res, routeId) => {
        const body = await parseBody(req);
        routeDb.removeTrainClass(routeId, body.class_id);
        sendJson(res, { success: true });
    },

    // GET /api/routes/:id/train-classes/:classId/trains
    getTrainsForClass: async (req, res, routeId, classId) => {
        const trains = routeDb.getTrainsForClass(routeId, classId);
        sendJson(res, trains);
    },

    // GET /api/routes/:id/train-classes-with-coordinates
    getTrainClassesWithCoordinates: async (req, res, routeId) => {
        const trainClasses = routeDb.getTrainClassesWithCoordinates(routeId);
        sendJson(res, trainClasses);
    },

    // GET /api/routes/:id/train-classes/:classId/trains-with-coordinates
    getTrainsForClassWithCoordinates: async (req, res, routeId, classId) => {
        const trains = routeDb.getTrainsForClassWithCoordinates(routeId, classId);
        sendJson(res, trains);
    }
};

module.exports = routeController;
