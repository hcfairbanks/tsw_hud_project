'use strict';
const { weatherPresetDb } = require('../db');
const { sendJson, parseBody } = require('../utils/http');

/**
 * Get all weather presets
 */
async function getAll(req, res) {
    const presets = weatherPresetDb.getAll();
    sendJson(res, presets);
}

/**
 * Get a single weather preset by ID
 */
async function getById(req, res, id) {
    const preset = weatherPresetDb.getById(id);
    if (!preset) {
        sendJson(res, { error: 'Preset not found' }, 404);
        return;
    }
    sendJson(res, preset);
}

/**
 * Create a new weather preset
 */
async function create(req, res) {
    try {
        const body = await parseBody(req);

        if (!body.name) {
            sendJson(res, { error: 'Name is required' }, 400);
            return;
        }

        // Check for duplicate name
        const existing = weatherPresetDb.getByName(body.name);
        if (existing) {
            sendJson(res, { error: 'A preset with this name already exists' }, 400);
            return;
        }

        const preset = {
            name: body.name,
            temperature: parseFloat(body.temperature) || 20,
            cloudiness: parseFloat(body.cloudiness) || 0,
            precipitation: parseFloat(body.precipitation) || 0,
            wetness: parseFloat(body.wetness) || 0,
            ground_snow: parseFloat(body.ground_snow) || 0,
            piled_snow: parseFloat(body.piled_snow) || 0,
            fog_density: parseFloat(body.fog_density) || 0
        };

        const result = weatherPresetDb.create(preset);
        const newPreset = weatherPresetDb.getById(result.lastInsertRowid);
        sendJson(res, newPreset, 201);
    } catch (err) {
        sendJson(res, { error: err.message }, 500);
    }
}

/**
 * Update a weather preset
 */
async function update(req, res, id) {
    try {
        const existing = weatherPresetDb.getById(id);
        if (!existing) {
            sendJson(res, { error: 'Preset not found' }, 404);
            return;
        }

        const body = await parseBody(req);

        if (!body.name) {
            sendJson(res, { error: 'Name is required' }, 400);
            return;
        }

        // Check for duplicate name (excluding current preset)
        const duplicate = weatherPresetDb.getByName(body.name);
        if (duplicate && duplicate.id !== id) {
            sendJson(res, { error: 'A preset with this name already exists' }, 400);
            return;
        }

        const preset = {
            name: body.name,
            temperature: parseFloat(body.temperature) || 20,
            cloudiness: parseFloat(body.cloudiness) || 0,
            precipitation: parseFloat(body.precipitation) || 0,
            wetness: parseFloat(body.wetness) || 0,
            ground_snow: parseFloat(body.ground_snow) || 0,
            piled_snow: parseFloat(body.piled_snow) || 0,
            fog_density: parseFloat(body.fog_density) || 0
        };

        weatherPresetDb.update(id, preset);
        const updated = weatherPresetDb.getById(id);
        sendJson(res, updated);
    } catch (err) {
        sendJson(res, { error: err.message }, 500);
    }
}

/**
 * Delete a weather preset
 */
async function remove(req, res, id) {
    const existing = weatherPresetDb.getById(id);
    if (!existing) {
        sendJson(res, { error: 'Preset not found' }, 404);
        return;
    }

    weatherPresetDb.delete(id);
    sendJson(res, { success: true, message: 'Preset deleted' });
}

module.exports = {
    getAll,
    getById,
    create,
    update,
    delete: remove
};
