'use strict';
const { sendJson, parseMultipart } = require('../utils/http');

// Helper to clean OCR values - convert standalone "-" to empty string
function cleanOcrValue(value) {
    if (!value) return '';
    const trimmed = String(value).trim();
    return trimmed === '-' ? '' : trimmed;
}

// OCR module - optional, may fail in compiled exe due to native deps
let ocr = null;
let ocrAvailable = false;
try {
    ocr = require('../ocr');
    ocrAvailable = true;
    console.log('✓ OCR module loaded');
} catch (err) {
    console.warn('⚠ OCR module not available (native deps missing). Extract feature disabled.');
    console.warn('  Run with "node server.js" for full OCR support.');
}

const ocrController = {
    // GET /api/ocr-status
    getStatus: async (req, res) => {
        sendJson(res, { available: ocrAvailable });
    },

    // POST /api/extract
    extract: async (req, res) => {
        if (!ocrAvailable) {
            sendJson(res, { error: 'OCR not available. Run server with "node server.js" for OCR support.' }, 503);
            return;
        }
        
        try {
            const parts = await parseMultipart(req);
            const imageBuffers = parts
                .filter(p => p.filename && /\.(png|jpg|jpeg|gif|bmp)$/i.test(p.filename))
                .sort((a, b) => a.filename.localeCompare(b.filename))
                .map(p => p.data);
            
            if (imageBuffers.length === 0) {
                sendJson(res, { error: 'No valid image files uploaded' }, 400);
                return;
            }
            
            console.log(`Processing ${imageBuffers.length} images for OCR...`);
            const result = await ocr.processImages(imageBuffers);
            
            // DO NOT save to database - just return parsed data for user review
            // User will click "Create Timetable" to save after reviewing/correcting
            // Clean OCR values - convert standalone "-" to empty string
            const entries = result.rows.map((row, index) => ({
                action: row.action,
                details: cleanOcrValue(row.details),
                location: cleanOcrValue(row.location),
                platform: cleanOcrValue(row.platform),
                time1: cleanOcrValue(row.time1),
                time2: cleanOcrValue(row.time2),
                latitude: cleanOcrValue(row.latitude),
                longitude: cleanOcrValue(row.longitude),
                sort_order: index
            }));
            
            // Return parsed data without id (indicates not yet saved)
            const response = {
                service_name: result.serviceName || 'Extracted Timetable',
                entries: entries,
                rawTexts: result.rawTexts
            };
            
            sendJson(res, response, 200);
        } catch (error) {
            console.error('OCR error:', error);
            sendJson(res, { error: error.message }, 500);
        }
    }
};

module.exports = ocrController;
