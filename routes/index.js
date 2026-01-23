'use strict';
const { serveFile, sendJson, parseBody } = require('../utils/http');
const countryController = require('../controllers/countryController');
const routeController = require('../controllers/routeController');
const trainController = require('../controllers/trainController');
const trainClassController = require('../controllers/trainClassController');
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
const routeProcessingController = require('../controllers/routeProcessingController');
const configController = require('../controllers/configController');
const subscriptionController = require('../controllers/subscriptionController');
const telemetryController = require('../controllers/telemetryController');
const { getDefaultPaths, getApiKey, getApiKeyPath } = require('../utils/apiKey');
const { getInternalIpAddress } = require('../utils/network');

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

    // Mobile HUD (optimized for Samsung Galaxy S23 landscape)
    if (pathname === '/hud_1' || pathname === '/hud_1.html') {
        serveFile(res, 'hud_1.html', 'text/html');
        return true;
    }

    // Tablet HUD (optimized for Samsung Tab S9 FE)
    if (pathname === '/hud_2' || pathname === '/hud_2.html') {
        serveFile(res, 'hud_2.html', 'text/html');
        return true;
    }

    // HUD 3
    if (pathname === '/hud_3' || pathname === '/hud_3.html') {
        serveFile(res, 'hud_3.html', 'text/html');
        return true;
    }

    // Live data page
    if (pathname === '/data' || pathname === '/data.html') {
        serveFile(res, 'data.html', 'text/html');
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
    if (pathname === '/record' || pathname === '/record.html') {
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

    // Train Classes list page
    if (pathname === '/train-classes') {
        serveFile(res, 'train-classes/index.html', 'text/html');
        return true;
    }

    // Train Class show page /train-classes/:id
    const trainClassShowMatch = pathname.match(/^\/train-classes\/(\d+)$/);
    if (trainClassShowMatch) {
        serveFile(res, 'train-classes/show.html', 'text/html');
        return true;
    }

    // Timetables list page
    if (pathname === '/timetables') {
        serveFile(res, 'timetables/index.html', 'text/html');
        return true;
    }

    // Timetable create page (must come before :id match)
    if (pathname === '/timetables/create') {
        serveFile(res, 'timetables/create.html', 'text/html');
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

    // Settings page
    if (pathname === '/settings' || pathname === '/settings.html') {
        serveFile(res, 'settings.html', 'text/html');
        return true;
    }

    // API Subscriptions page
    if (pathname === '/api-subscriptions' || pathname === '/api-subscriptions.html') {
        serveFile(res, 'api-subscriptions.html', 'text/html');
        return true;
    }

    // Weather preset show page /weather-presets/:id
    const weatherPresetShowMatch = pathname.match(/^\/weather-presets\/(\d+)$/);
    if (weatherPresetShowMatch) {
        serveFile(res, 'weather-presets/show.html', 'text/html');
        return true;
    }

    // CSS files
    if (pathname.startsWith('/css/') && pathname.endsWith('.css')) {
        serveFile(res, pathname.substring(1), 'text/css');
        return true;
    }

    // JS files
    if (pathname.startsWith('/js/') && pathname.endsWith('.js')) {
        serveFile(res, pathname.substring(1), 'application/javascript');
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

    // Route train classes API
    const routeTrainClassesMatch = pathname.match(/^\/api\/routes\/(\d+)\/train-classes$/);
    if (routeTrainClassesMatch) {
        const routeId = parseInt(routeTrainClassesMatch[1]);

        if (method === 'GET') {
            await routeController.getTrainClasses(req, res, routeId);
            return true;
        }
        if (method === 'POST') {
            await routeController.addTrainClass(req, res, routeId);
            return true;
        }
        if (method === 'DELETE') {
            await routeController.removeTrainClass(req, res, routeId);
            return true;
        }
    }

    // Get trains for a specific class on a route
    const routeClassTrainsMatch = pathname.match(/^\/api\/routes\/(\d+)\/train-classes\/(\d+)\/trains$/);
    if (routeClassTrainsMatch) {
        const routeId = parseInt(routeClassTrainsMatch[1]);
        const classId = parseInt(routeClassTrainsMatch[2]);

        if (method === 'GET') {
            await routeController.getTrainsForClass(req, res, routeId, classId);
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
    // Train Class API Routes
    // ============================================

    if (pathname === '/api/train-classes') {
        if (method === 'GET') {
            await trainClassController.getAll(req, res);
            return true;
        }
        if (method === 'POST') {
            await trainClassController.create(req, res);
            return true;
        }
    }

    // Single train class operations
    const trainClassMatch = pathname.match(/^\/api\/train-classes\/(\d+)$/);
    if (trainClassMatch) {
        const id = parseInt(trainClassMatch[1]);

        if (method === 'GET') {
            await trainClassController.getById(req, res, id);
            return true;
        }
        if (method === 'PUT') {
            await trainClassController.update(req, res, id);
            return true;
        }
        if (method === 'DELETE') {
            await trainClassController.delete(req, res, id);
            return true;
        }
    }

    // Train class trains API
    const trainClassTrainsMatch = pathname.match(/^\/api\/train-classes\/(\d+)\/trains$/);
    if (trainClassTrainsMatch) {
        const classId = parseInt(trainClassTrainsMatch[1]);

        if (method === 'GET') {
            await trainClassController.getTrains(req, res, classId);
            return true;
        }
    }

    // Train class routes API
    const trainClassRoutesMatch = pathname.match(/^\/api\/train-classes\/(\d+)\/routes$/);
    if (trainClassRoutesMatch) {
        const classId = parseInt(trainClassRoutesMatch[1]);

        if (method === 'GET') {
            await trainClassController.getRoutes(req, res, classId);
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

    // Import timetable from JSON (must come before single timetable operations)
    if (pathname === '/api/timetables/import' && method === 'POST') {
        await timetableController.import(req, res);
        return true;
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

    // Timetable trains API
    const timetableTrainsMatch = pathname.match(/^\/api\/timetables\/(\d+)\/trains$/);
    if (timetableTrainsMatch) {
        const timetableId = parseInt(timetableTrainsMatch[1]);

        if (method === 'GET') {
            await timetableController.getTrains(req, res, timetableId);
            return true;
        }
        if (method === 'POST') {
            await timetableController.addTrain(req, res, timetableId);
            return true;
        }
        if (method === 'DELETE') {
            await timetableController.removeTrain(req, res, timetableId);
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

    // Browse directory for routes
    if (pathname.startsWith('/api/hud/browse') && method === 'GET') {
        const requestedPath = url.searchParams.get('path') || '';
        await hudController.browseDirectory(req, res, requestedPath);
        return true;
    }

    // Load a specific route
    if (pathname.startsWith('/api/hud/load-route') && method === 'GET') {
        const filePath = url.searchParams.get('path');
        await hudController.loadRoute(req, res, filePath);
        return true;
    }

    // Upload route data from client
    if (pathname === '/api/upload-route' && method === 'POST') {
        await hudController.uploadRoute(req, res);
        return true;
    }

    // Clear current route
    if (pathname === '/api/clear-route' && method === 'POST') {
        await hudController.clearCurrentRoute(req, res);
        return true;
    }

    // Get timetable items for test selector
    if (pathname === '/api/timetable-items' && method === 'GET') {
        const data = telemetryController.getTimetableItems();
        sendJson(res, data);
        return true;
    }

    // Set timetable index for testing
    if (pathname === '/api/set-timetable-index' && method === 'POST') {
        const body = await parseBody(req);
        const success = telemetryController.setTimetableIndex(body.index);
        sendJson(res, { success });
        return true;
    }

    // Update timetable entry coordinates (for SAVE LOC button)
    if (pathname === '/api/update-timetable-coordinates' && method === 'POST') {
        await telemetryController.updateTimetableCoordinates(req, res);
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

    // Reset recording (for testing)
    if (pathname === '/api/recording/reset' && method === 'POST') {
        recordingController.reset(req, res);
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

    // Check for any existing recording file (most recent)
    if (pathname === '/api/recording/check-any-existing' && method === 'GET') {
        recordingController.checkAnyExistingRecording(req, res);
        return true;
    }

    // Check for existing recording file for a timetable
    const checkExistingMatch = pathname.match(/^\/api\/recording\/check-existing\/(\d+)$/);
    if (checkExistingMatch && method === 'GET') {
        const timetableId = parseInt(checkExistingMatch[1]);
        recordingController.checkExistingRecording(req, res, timetableId);
        return true;
    }

    // Load a specific recording file
    if (pathname === '/api/recording/load-file' && method === 'POST') {
        const filename = url.searchParams.get('file');
        recordingController.loadRecordingFile(req, res, filename);
        return true;
    }

    // Delete a raw recording file (called after DB save in normal mode)
    if (pathname.startsWith('/api/recording/delete-file/') && method === 'DELETE') {
        const filename = pathname.replace('/api/recording/delete-file/', '');
        recordingController.deleteRawFile(req, res, decodeURIComponent(filename));
        return true;
    }

    // Set recording mode (manual/automatic)
    if (pathname === '/api/recording/mode' && method === 'POST') {
        recordingController.setMode(req, res);
        return true;
    }

    // Get current recording mode
    if (pathname === '/api/recording/mode' && method === 'GET') {
        recordingController.getMode(req, res);
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

    // Save processed JSON to database
    if (pathname === '/api/map/save-processed' && method === 'POST') {
        await mapDataController.saveProcessedJson(req, res);
        return true;
    }

    // Get route data from database for live map (no file)
    const routeDataFromDbMatch = pathname.match(/^\/api\/map\/route-data\/(\d+)$/);
    if (routeDataFromDbMatch && method === 'GET') {
        const timetableId = parseInt(routeDataFromDbMatch[1]);
        await mapDataController.getRouteDataFromDb(req, res, timetableId);
        return true;
    }

    // Remake processed JSON from database data
    if (pathname === '/api/map/remake' && method === 'POST') {
        await mapDataController.remakeProcessedJson(req, res);
        return true;
    }

    // ============================================
    // Config API Routes
    // ============================================

    if (pathname === '/api/config') {
        if (method === 'GET') {
            configController.getConfig(req, res);
            return true;
        }
        if (method === 'PUT') {
            await configController.updateConfig(req, res);
            return true;
        }
    }

    // Get default TSW API key paths
    if (pathname === '/api/config/default-paths' && method === 'GET') {
        sendJson(res, getDefaultPaths());
        return true;
    }

    // Get current API key info
    if (pathname === '/api/config/current-key' && method === 'GET') {
        const config = configController.loadConfig();
        const currentKey = getApiKey();
        const currentPath = getApiKeyPath();

        let source = 'Not found';
        if (config.apiKey && config.apiKey.trim()) {
            source = 'Direct API key override';
        } else if (currentKey) {
            const tswVersion = config.tswVersion || 'tsw6';
            source = `${tswVersion.toUpperCase()} path: ${currentPath}`;
        }

        sendJson(res, {
            key: currentKey || null,
            path: currentPath,
            source: source,
            hasKey: !!currentKey
        });
        return true;
    }

    // Get server URLs
    if (pathname === '/api/config/server-urls' && method === 'GET') {
        const ip = getInternalIpAddress();
        const port = 3000;
        sendJson(res, {
            local: `http://localhost:${port}`,
            network: `http://${ip}:${port}`
        });
        return true;
    }

    // ============================================
    // Subscription Management API Routes
    // ============================================

    // Get subscription status
    if (pathname === '/api/subscription/status' && method === 'GET') {
        subscriptionController.getStatus(req, res);
        return true;
    }

    // Reset subscriptions (delete and recreate)
    if (pathname === '/api/subscription/reset' && method === 'POST') {
        await subscriptionController.resetSubscriptionsHandler(req, res);
        return true;
    }

    // Delete subscriptions only
    if (pathname === '/api/subscription/delete' && method === 'POST') {
        await subscriptionController.deleteSubscriptionsHandler(req, res);
        return true;
    }

    // Create subscriptions only
    if (pathname === '/api/subscription/create' && method === 'POST') {
        await subscriptionController.createSubscriptionsHandler(req, res);
        return true;
    }

    // Get live subscription data
    if (pathname === '/api/subscription/data' && method === 'GET') {
        await subscriptionController.getSubscriptionData(req, res);
        return true;
    }

    // ============================================
    // Route Processing API Routes
    // ============================================

    // Process the most recent recording file
    if (pathname === '/api/route-processing/process-latest' && method === 'POST') {
        routeProcessingController.processLatestRecording(req, res);
        return true;
    }

    // List processed route files
    if (pathname === '/api/route-processing/list' && method === 'GET') {
        routeProcessingController.listProcessedRoutes(req, res);
        return true;
    }

    // Get a specific processed route file
    if (pathname === '/api/route-processing/file' && method === 'GET') {
        const filename = url.searchParams.get('file');
        routeProcessingController.getProcessedRoute(req, res, filename);
        return true;
    }

    // No route matched
    return false;
}

module.exports = { handleRoutes };
