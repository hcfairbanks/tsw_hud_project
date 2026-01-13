'use strict';
const { routeDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

const routeController = {
    // GET /api/routes
    getAll: async (req, res) => {
        const routes = routeDb.getAll();
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
            sendJson(res, route);
        } else {
            sendJson(res, { error: 'Route not found' }, 404);
        }
    },

    // PUT /api/routes/:id
    update: async (req, res, id) => {
        const body = await parseBody(req);
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
    }
};

module.exports = routeController;
