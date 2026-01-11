'use strict';
const { stationMappingDb, routeDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

const stationMappingController = {
    // GET /api/station-mappings
    // Optional query param: route_id
    getAll: async (req, res, routeId = null) => {
        const mappings = stationMappingDb.getAll(routeId);

        // Include route name for display
        const mappingsWithRoute = mappings.map(m => {
            const result = { ...m };
            if (m.route_id) {
                const route = routeDb.getById(m.route_id);
                result.route_name = route ? route.name : null;
            } else {
                result.route_name = 'Global';
            }
            return result;
        });

        sendJson(res, mappingsWithRoute);
    },

    // GET /api/station-mappings/:id
    getById: async (req, res, id) => {
        const mapping = stationMappingDb.getById(id);
        if (mapping) {
            if (mapping.route_id) {
                const route = routeDb.getById(mapping.route_id);
                mapping.route_name = route ? route.name : null;
            } else {
                mapping.route_name = 'Global';
            }
            sendJson(res, mapping);
        } else {
            sendJson(res, { error: 'Mapping not found' }, 404);
        }
    },

    // GET /api/station-mappings/route/:routeId
    getByRouteId: async (req, res, routeId) => {
        const mappings = stationMappingDb.getByRouteId(routeId);
        sendJson(res, mappings);
    },

    // GET /api/station-mappings/lookup/:routeId
    // Returns a simple { displayName: apiName } object for use in processing
    getLookup: async (req, res, routeId = null) => {
        const lookup = stationMappingDb.getMappingObject(routeId);
        sendJson(res, lookup);
    },

    // POST /api/station-mappings
    create: async (req, res) => {
        const body = await parseBody(req);

        if (!body.display_name || !body.api_name) {
            sendJson(res, { error: 'display_name and api_name are required' }, 400);
            return;
        }

        try {
            const result = stationMappingDb.create(
                body.display_name,
                body.api_name,
                body.route_id || null
            );

            sendJson(res, {
                id: result.lastInsertRowid,
                display_name: body.display_name,
                api_name: body.api_name,
                route_id: body.route_id || null
            }, 201);
        } catch (err) {
            if (err.message && err.message.includes('UNIQUE constraint')) {
                sendJson(res, { error: 'A mapping for this display name already exists for this route' }, 409);
            } else {
                sendJson(res, { error: err.message }, 500);
            }
        }
    },

    // PUT /api/station-mappings/:id
    update: async (req, res, id) => {
        const body = await parseBody(req);

        const existing = stationMappingDb.getById(id);
        if (!existing) {
            sendJson(res, { error: 'Mapping not found' }, 404);
            return;
        }

        try {
            stationMappingDb.update(
                id,
                body.display_name || existing.display_name,
                body.api_name || existing.api_name,
                body.route_id !== undefined ? body.route_id : existing.route_id
            );

            sendJson(res, {
                id,
                display_name: body.display_name || existing.display_name,
                api_name: body.api_name || existing.api_name,
                route_id: body.route_id !== undefined ? body.route_id : existing.route_id
            });
        } catch (err) {
            sendJson(res, { error: err.message }, 500);
        }
    },

    // DELETE /api/station-mappings/:id
    delete: async (req, res, id) => {
        const existing = stationMappingDb.getById(id);
        if (!existing) {
            sendJson(res, { error: 'Mapping not found' }, 404);
            return;
        }

        stationMappingDb.delete(id);
        sendJson(res, { success: true });
    },

    // POST /api/station-mappings/bulk
    // Bulk import mappings from an array
    bulkImport: async (req, res) => {
        const body = await parseBody(req);

        if (!body.mappings || !Array.isArray(body.mappings)) {
            sendJson(res, { error: 'mappings array is required' }, 400);
            return;
        }

        try {
            const count = stationMappingDb.bulkInsert(body.mappings, body.route_id || null);
            sendJson(res, {
                success: true,
                imported: count
            });
        } catch (err) {
            sendJson(res, { error: err.message }, 500);
        }
    },

    // POST /api/station-mappings/import-object
    // Import from a { displayName: apiName } object format
    importFromObject: async (req, res) => {
        const body = await parseBody(req);

        if (!body.mappings || typeof body.mappings !== 'object') {
            sendJson(res, { error: 'mappings object is required' }, 400);
            return;
        }

        try {
            const count = stationMappingDb.importFromObject(body.mappings, body.route_id || null);
            sendJson(res, {
                success: true,
                imported: count
            });
        } catch (err) {
            sendJson(res, { error: err.message }, 500);
        }
    }
};

module.exports = stationMappingController;
