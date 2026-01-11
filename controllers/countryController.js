'use strict';
const { countryDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

const countryController = {
    // GET /api/countries
    getAll: async (req, res) => {
        const countries = countryDb.getAll();
        sendJson(res, countries);
    },

    // GET /api/countries/:id
    getById: async (req, res, id) => {
        const country = countryDb.getById(id);
        if (!country) {
            sendJson(res, { error: 'Country not found' }, 404);
            return;
        }
        sendJson(res, country);
    },

    // POST /api/countries
    create: async (req, res) => {
        const body = await parseBody(req);
        const name = body.name;
        const code = body.code || null;

        if (!name) {
            sendJson(res, { error: 'Country name is required' }, 400);
            return;
        }

        // Check if country already exists
        const existing = countryDb.getByName(name);
        if (existing) {
            sendJson(res, { error: 'Country already exists', id: existing.id }, 409);
            return;
        }

        const result = countryDb.create(name, code);
        sendJson(res, { id: result.lastInsertRowid, name, code }, 201);
    },

    // PUT /api/countries/:id
    update: async (req, res, id) => {
        const body = await parseBody(req);
        const name = body.name;
        const code = body.code || null;

        if (!name) {
            sendJson(res, { error: 'Country name is required' }, 400);
            return;
        }

        countryDb.update(id, name, code);
        sendJson(res, { id, name, code });
    },

    // DELETE /api/countries/:id
    delete: async (req, res, id) => {
        countryDb.delete(id);
        sendJson(res, { success: true });
    },

    // GET /api/countries/:id/routes
    getRoutes: async (req, res, id) => {
        const routes = countryDb.getRoutes(id);
        sendJson(res, routes);
    }
};

module.exports = countryController;
