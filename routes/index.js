'use strict';
const { serveFile, sendJson } = require('../utils/http');
const countryController = require('../controllers/countryController');
const routeController = require('../controllers/routeController');
const trainController = require('../controllers/trainController');
const timetableController = require('../controllers/timetableController');
const entryController = require('../controllers/entryController');
const ocrController = require('../controllers/ocrController');

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
            await timetableController.getAll(req, res);
            return true;
        }
        if (method === 'POST') {
            await timetableController.create(req, res);
            return true;
        }
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

    // No route matched
    return false;
}

module.exports = { handleRoutes };
