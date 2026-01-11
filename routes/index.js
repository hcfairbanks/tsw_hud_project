'use strict';
const { serveFile, sendJson } = require('../utils/http');
const countryController = require('../controllers/countryController');
const routeController = require('../controllers/routeController');
const trainController = require('../controllers/trainController');
const timetableController = require('../controllers/timetableController');
const entryController = require('../controllers/entryController');
const ocrController = require('../controllers/ocrController');
const hudController = require('../controllers/hudController');
const streamController = require('../controllers/streamController');
const weatherController = require('../controllers/weatherController');
const weatherPresetController = require('../controllers/weatherPresetController');
const recordingController = require('../controllers/recordingController');
const processingController = require('../controllers/processingController');
const mapDataController = require('../controllers/mapDataController');
const stationMappingController = require('../controllers/stationMappingController');

/**
 * Route handler - maps URL patterns to controller methods
 */
async function handleRoutes(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    console.log(`${method} ${pathname}`);

    // ============================================
    // Static File Routes (Views)
    // ============================================
    
    if (pathname === '/' || pathname === '/index.html') {
        serveFile(res, 'index.html', 'text/html');
        return true;
    }
    
    if (pathname === '/extract' || pathname === '/extract.html') {
        serveFile(res, 'extract.html', 'text/html');
        return true;
    }

    // HUD dashboard page
    if (pathname === '/hud' || pathname === '/hud.html') {
        serveFile(res, 'hud.html', 'text/html');
        return true;
    }

    // Live map page
    if (pathname === '/map' || pathname === '/map.html') {
        serveFile(res, 'map.html', 'text/html');
        return true;
    }

    // Weather control page
    if (pathname === '/weather' || pathname === '/weather.html') {
        serveFile(res, 'weather.html', 'text/html');
        return true;
    }

    // Record map page for manual coordinate entry
    if (pathname === '/record-map' || pathname === '/record-map.html') {
        serveFile(res, 'record-map.html', 'text/html');
        return true;
    }

    if (pathname === '/routes') {
        serveFile(res, 'routes/index.html', 'text/html');
        return true;
    }

    // Route show page /routes/:id
    const routeShowMatch = pathname.match(/^\/routes\/(\d+)$/);
    if (routeShowMatch) {
        serveFile(res, 'routes/show.html', 'text/html');
        return true;
    }

    // Trains list page
    if (pathname === '/trains') {
        serveFile(res, 'trains/index.html', 'text/html');
        return true;
    }

    // Train show page /trains/:id
    const trainShowMatch = pathname.match(/^\/trains\/(\d+)$/);
    if (trainShowMatch) {
        serveFile(res, 'trains/show.html', 'text/html');
        return true;
    }

    // Timetables list page
    if (pathname === '/timetables') {
        serveFile(res, 'timetables/index.html', 'text/html');
        return true;
    }

    // Timetable show page /timetables/:id
    const timetableShowMatch = pathname.match(/^\/timetables\/(\d+)$/);
    if (timetableShowMatch) {
        serveFile(res, 'timetables/show.html', 'text/html');
        return true;
    }

    // Countries list page
    if (pathname === '/countries') {
        serveFile(res, 'countries/index.html', 'text/html');
        return true;
    }

    // Country show page /countries/:id
    const countryShowMatch = pathname.match(/^\/countries\/(\d+)$/);
    if (countryShowMatch) {
        serveFile(res, 'countries/show.html', 'text/html');
        return true;
    }

    // Weather presets list page
    if (pathname === '/weather-presets') {
        serveFile(res, 'weather-presets/index.html', 'text/html');
        return true;
    }

    // Weather preset show page /weather-presets/:id
    const weatherPresetShowMatch = pathname.match(/^\/weather-presets\/(\d+)$/);
    if (weatherPresetShowMatch) {
        serveFile(res, 'weather-presets/show.html', 'text/html');
        return true;
    }

    // ============================================
    // Country API Routes
    // ============================================

    if (pathname === '/api/countries') {
        if (method === 'GET') {
            await countryController.getAll(req, res);
            return true;
        }
        if (method === 'POST') {
            await countryController.create(req, res);
            return true;
        }
    }

    // Single country operations
    const countryMatch = pathname.match(/^\/api\/countries\/(\d+)$/);
    if (countryMatch) {
        const id = parseInt(countryMatch[1]);

        if (method === 'GET') {
            await countryController.getById(req, res, id);
            return true;
        }
        if (method === 'PUT') {
            await countryController.update(req, res, id);
            return true;
        }
        if (method === 'DELETE') {
            await countryController.delete(req, res, id);
            return true;
        }
    }

    // Country routes API
    const countryRoutesMatch = pathname.match(/^\/api\/countries\/(\d+)\/routes$/);
    if (countryRoutesMatch) {
        const countryId = parseInt(countryRoutesMatch[1]);

        if (method === 'GET') {
            await countryController.getRoutes(req, res, countryId);
            return true;
        }
    }

    // ============================================
    // Route API Routes
    // ============================================
    

    // Paginated routes endpoint
    if (pathname === '/api/routes/paginated' && method === 'GET') {
        await routeController.getPaginated(req, res);
        return true;
    }

    if (pathname === '/api/routes') {
        if (method === 'GET') {
            await routeController.getAll(req, res);
            return true;
        }
        if (method === 'POST') {
            await routeController.create(req, res);
            return true;
        }
    }

    // Single route operations
    const routeMatch = pathname.match(/^\/api\/routes\/(\d+)$/);
    if (routeMatch) {
        const id = parseInt(routeMatch[1]);
        
        if (method === 'GET') {
            await routeController.getById(req, res, id);
            return true;
        }
        if (method === 'PUT') {
            await routeController.update(req, res, id);
            return true;
        }
        if (method === 'DELETE') {
            await routeController.delete(req, res, id);
            return true;
        }
    }

    // Route trains API
    const routeTrainsMatch = pathname.match(/^\/api\/routes\/(\d+)\/trains$/);
    if (routeTrainsMatch) {
        const routeId = parseInt(routeTrainsMatch[1]);
        
        if (method === 'GET') {
            await routeController.getTrains(req, res, routeId);
            return true;
        }
        if (method === 'POST') {
            await routeController.addTrain(req, res, routeId);
            return true;
        }
        if (method === 'DELETE') {
            await routeController.removeTrain(req, res, routeId);
            return true;
        }
    }

    // ============================================
    // Train API Routes
    // ============================================
    
    if (pathname === '/api/trains') {
        if (method === 'GET') {
            await trainController.getAll(req, res);
            return true;
        }
        if (method === 'POST') {
            await trainController.create(req, res);
            return true;
        }
    }

    // Single train operations
    const trainMatch = pathname.match(/^\/api\/trains\/(\d+)$/);
    if (trainMatch) {
        const id = parseInt(trainMatch[1]);
        
        if (method === 'GET') {
            await trainController.getById(req, res, id);
            return true;
        }
        if (method === 'PUT') {
            await trainController.update(req, res, id);
            return true;
        }
        if (method === 'DELETE') {
            await trainController.delete(req, res, id);
            return true;
        }
    }

    // Train routes API
    const trainRoutesMatch = pathname.match(/^\/api\/trains\/(\d+)\/routes$/);
    if (trainRoutesMatch) {
        const trainId = parseInt(trainRoutesMatch[1]);
        
        if (method === 'GET') {
            await trainController.getRoutes(req, res, trainId);
            return true;
        }
    }

    // ============================================
    // Timetable API Routes
    // ============================================
    
    if (pathname === '/api/timetables') {
        if (method === 'GET') {
            const routeId = url.searchParams.get('route_id') ? parseInt(url.searchParams.get('route_id')) : null;
            const trainId = url.searchParams.get('train_id') ? parseInt(url.searchParams.get('train_id')) : null;
            await timetableController.getAll(req, res, routeId, trainId);
            return true;
        }
        if (method === 'POST') {
            await timetableController.create(req, res);
            return true;
        }
    }

    // Timetable export endpoints (must come before single timetable operations)
    const timetableExportDownloadMatch = pathname.match(/^\/api\/timetables\/(\d+)\/export\/download$/);
    if (timetableExportDownloadMatch && method === 'GET') {
        const id = parseInt(timetableExportDownloadMatch[1]);
        await timetableController.exportDownload(req, res, id);
        return true;
    }

    const timetableExportMatch = pathname.match(/^\/api\/timetables\/(\d+)\/export$/);
    if (timetableExportMatch && method === 'GET') {
        const id = parseInt(timetableExportMatch[1]);
        await timetableController.export(req, res, id);
        return true;
    }

    // Single timetable operations
    const timetableMatch = pathname.match(/^\/api\/timetables\/(\d+)$/);
    if (timetableMatch) {
        const id = parseInt(timetableMatch[1]);

        if (method === 'GET') {
            await timetableController.getById(req, res, id);
            return true;
        }
        if (method === 'PUT') {
            await timetableController.update(req, res, id);
            return true;
        }
        if (method === 'DELETE') {
            await timetableController.delete(req, res, id);
            return true;
        }
    }

    // ============================================
    // Station Name Mapping API Routes
    // ============================================

    // GET /api/station-mappings - Get all mappings (optional ?route_id=X)
    // POST /api/station-mappings - Create a new mapping
    if (pathname === '/api/station-mappings') {
        if (method === 'GET') {
            const routeId = url.searchParams.get('route_id') ? parseInt(url.searchParams.get('route_id')) : null;
            await stationMappingController.getAll(req, res, routeId);
            return true;
        }
        if (method === 'POST') {
            await stationMappingController.create(req, res);
            return true;
        }
    }

    // GET /api/station-mappings/lookup/:routeId - Get lookup object for processing
    const mappingLookupMatch = pathname.match(/^\/api\/station-mappings\/lookup\/(\d+)$/);
    if (mappingLookupMatch && method === 'GET') {
        const routeId = parseInt(mappingLookupMatch[1]);
        await stationMappingController.getLookup(req, res, routeId);
        return true;
    }

    // GET /api/station-mappings/lookup - Get global lookup object
    if (pathname === '/api/station-mappings/lookup' && method === 'GET') {
        await stationMappingController.getLookup(req, res, null);
        return true;
    }

    // POST /api/station-mappings/bulk - Bulk import mappings
    if (pathname === '/api/station-mappings/bulk' && method === 'POST') {
        await stationMappingController.bulkImport(req, res);
        return true;
    }

    // POST /api/station-mappings/import-object - Import from { displayName: apiName } object
    if (pathname === '/api/station-mappings/import-object' && method === 'POST') {
        await stationMappingController.importFromObject(req, res);
        return true;
    }

    // GET /api/station-mappings/route/:routeId - Get mappings for a specific route
    const mappingRouteMatch = pathname.match(/^\/api\/station-mappings\/route\/(\d+)$/);
    if (mappingRouteMatch && method === 'GET') {
        const routeId = parseInt(mappingRouteMatch[1]);
        await stationMappingController.getByRouteId(req, res, routeId);
        return true;
    }

    // Single mapping operations: GET, PUT, DELETE /api/station-mappings/:id
    const mappingMatch = pathname.match(/^\/api\/station-mappings\/(\d+)$/);
    if (mappingMatch) {
        const id = parseInt(mappingMatch[1]);

        if (method === 'GET') {
            await stationMappingController.getById(req, res, id);
            return true;
        }
        if (method === 'PUT') {
            await stationMappingController.update(req, res, id);
            return true;
        }
        if (method === 'DELETE') {
            await stationMappingController.delete(req, res, id);
            return true;
        }
    }

    // ============================================
    // Entry API Routes
    // ============================================

    // Timetable entries API
    const entriesMatch = pathname.match(/^\/api\/timetables\/(\d+)\/entries$/);
    if (entriesMatch) {
        const timetableId = parseInt(entriesMatch[1]);
        
        if (method === 'GET') {
            await entryController.getByTimetableId(req, res, timetableId);
            return true;
        }
        if (method === 'POST') {
            await entryController.create(req, res, timetableId);
            return true;
        }
    }

    // Single entry operations
    const entryMatch = pathname.match(/^\/api\/entries\/(\d+)$/);
    if (entryMatch) {
        const id = parseInt(entryMatch[1]);
        
        if (method === 'PUT') {
            await entryController.update(req, res, id);
            return true;
        }
        if (method === 'DELETE') {
            await entryController.delete(req, res, id);
            return true;
        }
    }

    // ============================================
    // OCR API Routes
    // ============================================
    
    if (pathname === '/api/ocr-status' && method === 'GET') {
        await ocrController.getStatus(req, res);
        return true;
    }

    if (pathname === '/api/extract' && method === 'POST') {
        await ocrController.extract(req, res);
        return true;
    }

    // ============================================
    // HUD & Telemetry API Routes
    // ============================================

    // SSE stream for live telemetry
    if (pathname === '/stream') {
        await streamController.handleStream(req, res);
        return true;
    }

    // Get current route data
    if (pathname === '/route-data' && method === 'GET') {
        await hudController.getCurrentRoute(req, res);
        return true;
    }

    // List available route files
    if (pathname === '/api/hud/routes' && method === 'GET') {
        await hudController.listRoutes(req, res);
        return true;
    }

    // Browse directory for routes
    if (pathname.startsWith('/api/hud/browse') && method === 'GET') {
        const requestedPath = url.searchParams.get('path') || '';
        await hudController.browseDirectory(req, res, requestedPath);
        return true;
    }

    // Load a specific route
    if (pathname.startsWith('/api/hud/load-route') && method === 'GET') {
        const filename = url.searchParams.get('file');
        const type = url.searchParams.get('type') || 'processed';
        const filePath = url.searchParams.get('path');
        await hudController.loadRoute(req, res, filename, type, filePath);
        return true;
    }

    // Upload route data from client
    if (pathname === '/api/upload-route' && method === 'POST') {
        await hudController.uploadRoute(req, res);
        return true;
    }

    // ============================================
    // Weather API Routes
    // ============================================

    // Set weather value
    if (pathname === '/api/weather/set' && method === 'PATCH') {
        const key = url.searchParams.get('key');
        const value = parseFloat(url.searchParams.get('value'));
        await weatherController.setWeather(req, res, key, value);
        return true;
    }

    // ============================================
    // Weather Preset API Routes
    // ============================================

    if (pathname === '/api/weather-presets') {
        if (method === 'GET') {
            await weatherPresetController.getAll(req, res);
            return true;
        }
        if (method === 'POST') {
            await weatherPresetController.create(req, res);
            return true;
        }
    }

    // Single weather preset operations
    const weatherPresetMatch = pathname.match(/^\/api\/weather-presets\/(\d+)$/);
    if (weatherPresetMatch) {
        const id = parseInt(weatherPresetMatch[1]);

        if (method === 'GET') {
            await weatherPresetController.getById(req, res, id);
            return true;
        }
        if (method === 'PUT') {
            await weatherPresetController.update(req, res, id);
            return true;
        }
        if (method === 'DELETE') {
            await weatherPresetController.delete(req, res, id);
            return true;
        }
    }

    // ============================================
    // Recording API Routes
    // ============================================

    // Recording status
    if (pathname === '/api/recording/status' && method === 'GET') {
        recordingController.getStatus(req, res);
        return true;
    }

    // Start recording for a timetable
    const recordingStartMatch = pathname.match(/^\/api\/recording\/start\/(\d+)$/);
    if (recordingStartMatch && method === 'POST') {
        const timetableId = parseInt(recordingStartMatch[1]);
        await recordingController.start(req, res, timetableId);
        return true;
    }

    // Stop recording
    if (pathname === '/api/recording/stop' && method === 'POST') {
        recordingController.stop(req, res);
        return true;
    }

    // Pause recording
    if (pathname === '/api/recording/pause' && method === 'POST') {
        recordingController.pause(req, res);
        return true;
    }

    // Resume recording
    if (pathname === '/api/recording/resume' && method === 'POST') {
        recordingController.resume(req, res);
        return true;
    }

    // Get current route data for record map
    if (pathname === '/api/recording/route-data' && method === 'GET') {
        recordingController.getRouteData(req, res);
        return true;
    }

    // Save coordinates to timetable entry
    if (pathname === '/api/recording/save-timetable-coords' && method === 'POST') {
        await recordingController.saveTimetableCoords(req, res);
        return true;
    }

    // List recorded files
    if (pathname === '/api/recording/list' && method === 'GET') {
        recordingController.listRecordings(req, res);
        return true;
    }

    // Get a specific recording file
    if (pathname === '/api/recording/file' && method === 'GET') {
        const filename = url.searchParams.get('file');
        recordingController.getRecordingFile(req, res, filename);
        return true;
    }

    // ============================================
    // Processing API Routes
    // ============================================

    // Process a recording file
    if (pathname.startsWith('/api/processing/process') && method === 'POST') {
        const filename = url.searchParams.get('file');
        await processingController.process(req, res, filename);
        return true;
    }

    // List processed files
    if (pathname === '/api/processing/list' && method === 'GET') {
        processingController.listProcessed(req, res);
        return true;
    }

    // Get a processed file
    if (pathname.startsWith('/api/processing/file') && method === 'GET') {
        const filename = url.searchParams.get('file');
        processingController.getProcessedFile(req, res, filename);
        return true;
    }

    // Process a timetable's recording data (database-based)
    if (pathname === '/api/processing/timetable' && method === 'POST') {
        await processingController.processRecordingData(req, res);
        return true;
    }

    // ============================================
    // Map Data API Routes (timetable-based)
    // ============================================

    // Get all timetables for map selector
    if (pathname === '/api/map/timetables' && method === 'GET') {
        mapDataController.getAllTimetables(req, res);
        return true;
    }

    // Get timetables that have coordinate data
    if (pathname === '/api/map/timetables-with-data' && method === 'GET') {
        mapDataController.getTimetablesWithData(req, res);
        return true;
    }

    // Get full timetable data (coordinates, markers, entries) for map display
    const mapTimetableDataMatch = pathname.match(/^\/api\/map\/timetables\/(\d+)\/data$/);
    if (mapTimetableDataMatch && method === 'GET') {
        const timetableId = parseInt(mapTimetableDataMatch[1]);
        mapDataController.getTimetableData(req, res, timetableId);
        return true;
    }

    // Import recording data into a timetable
    if (pathname === '/api/map/import-recording' && method === 'POST') {
        await mapDataController.importFromRecording(req, res);
        return true;
    }

    // No route matched
    return false;
}

module.exports = { handleRoutes };
