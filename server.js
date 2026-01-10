'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { networkInterfaces } = require('os');
const initSqlJs = require('sql.js');

// OCR module - optional, may fail in compiled exe due to native deps
let ocr = null;
let ocrAvailable = false;
try {
    ocr = require('./ocr');
    ocrAvailable = true;
    console.log('✓ OCR module loaded');
} catch (err) {
    console.warn('⚠ OCR module not available (native deps missing). Extract feature disabled.');
    console.warn('  Run with "node server.js" for full OCR support.');
}

const PORT = 3000;
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB limit

// Get the directory where the exe is running from (works for both dev and compiled)
const appDir = process.pkg ? path.dirname(process.execPath) : __dirname;

// Database setup - always use the project root (parent of dist when running exe)
// This ensures both exe and dev mode use the same db file
const projectRoot = process.pkg ? path.dirname(path.dirname(process.execPath)) : __dirname;
const dbPath = path.join(projectRoot, 'tsw_hud.db');
let db = null;

console.log(`Database location: ${dbPath}`);

// Initialize database
async function initDatabase() {
    // Locate the wasm file - check multiple locations
    const wasmPaths = [
        path.join(appDir, 'sql-wasm.wasm'),
        path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        path.join(appDir, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    ];
    
    let wasmBinary = null;
    for (const wasmPath of wasmPaths) {
        if (fs.existsSync(wasmPath)) {
            wasmBinary = fs.readFileSync(wasmPath);
            console.log(`✓ Found sql-wasm.wasm at: ${wasmPath}`);
            break;
        }
    }
    
    const SQL = await initSqlJs({
        wasmBinary: wasmBinary
    });
    
    // Load existing database or create new one
    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
        console.log('✓ Loaded existing database');
    } else {
        db = new SQL.Database();
        console.log('✓ Created new database');
    }
    
    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            country TEXT NOT NULL,
            tsw_version INTEGER NOT NULL DEFAULT 3
        )
    `);
    
    // Trains table
    db.run(`
        CREATE TABLE IF NOT EXISTS trains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
    `);
    
    // Route-Train junction table (many-to-many)
    db.run(`
        CREATE TABLE IF NOT EXISTS route_trains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER NOT NULL,
            train_id INTEGER NOT NULL,
            FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
            FOREIGN KEY (train_id) REFERENCES trains(id) ON DELETE CASCADE,
            UNIQUE(route_id, train_id)
        )
    `);
    
    // Timetables table - stores parsed timetable sessions
    db.run(`
        CREATE TABLE IF NOT EXISTS timetables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_name TEXT NOT NULL,
            route_id INTEGER,
            train_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE SET NULL,
            FOREIGN KEY (train_id) REFERENCES trains(id) ON DELETE SET NULL
        )
    `);
    
    // Timetable entries - individual rows from the timetable
    db.run(`
        CREATE TABLE IF NOT EXISTS timetable_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timetable_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            details TEXT,
            location TEXT,
            platform TEXT,
            time1 TEXT,
            time2 TEXT,
            latitude TEXT,
            longitude TEXT,
            sort_order INTEGER,
            FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
        )
    `);
    
    // Add latitude and longitude columns if they don't exist (for existing databases)
    try {
        db.run('ALTER TABLE timetable_entries ADD COLUMN latitude TEXT');
    } catch (e) { /* column already exists */ }
    try {
        db.run('ALTER TABLE timetable_entries ADD COLUMN longitude TEXT');
    } catch (e) { /* column already exists */ }
    
    // Add tsw_version column to routes if it doesn't exist (migration for existing databases)
    try {
        db.run('ALTER TABLE routes ADD COLUMN tsw_version INTEGER NOT NULL DEFAULT 3');
    } catch (e) { /* column already exists */ }
    
    // Add route_id and train_id columns to timetables if they don't exist (migration)
    try {
        db.run('ALTER TABLE timetables ADD COLUMN route_id INTEGER REFERENCES routes(id) ON DELETE SET NULL');
    } catch (e) { /* column already exists */ }
    try {
        db.run('ALTER TABLE timetables ADD COLUMN train_id INTEGER REFERENCES trains(id) ON DELETE SET NULL');
    } catch (e) { /* column already exists */ }
    
    saveDatabase();
    console.log('✓ Database initialized');
}

// Seed database with routes and trains from JSON files
async function seedDatabase() {
    const routesFile = path.join(__dirname, 'routes.json');
    const trainsFile = path.join(__dirname, 'trains.json');
    const routeTrainsFile = path.join(__dirname, 'route_trains.json');
    
    if (!fs.existsSync(routesFile) || !fs.existsSync(trainsFile) || !fs.existsSync(routeTrainsFile)) {
        console.log('⚠ Seed files not found, skipping database seeding');
        return;
    }
    
    // Check if already seeded
    const routeCount = db.exec('SELECT COUNT(*) as count FROM routes')[0]?.values[0][0] || 0;
    if (routeCount > 0) {
        console.log(`✓ Database already has ${routeCount} routes, skipping seed`);
        return;
    }
    
    console.log('Seeding database...');
    
    const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
    const trains = JSON.parse(fs.readFileSync(trainsFile, 'utf8'));
    const routeTrains = JSON.parse(fs.readFileSync(routeTrainsFile, 'utf8'));
    
    // Insert trains
    const trainStmt = db.prepare('INSERT INTO trains (id, name) VALUES (?, ?)');
    for (const train of trains) {
        trainStmt.run([train.id, train.name]);
    }
    trainStmt.free();
    console.log(`  ✓ Inserted ${trains.length} trains`);
    
    // Insert routes
    const routeStmt = db.prepare('INSERT INTO routes (id, name, country, tsw_version) VALUES (?, ?, ?, ?)');
    for (const route of routes) {
        routeStmt.run([route.id, route.name, route.country, route.tsw_version]);
    }
    routeStmt.free();
    console.log(`  ✓ Inserted ${routes.length} routes`);
    
    // Insert route-train relationships
    const rtStmt = db.prepare('INSERT INTO route_trains (route_id, train_id) VALUES (?, ?)');
    for (const rt of routeTrains) {
        rtStmt.run([rt.route_id, rt.train_id]);
    }
    rtStmt.free();
    console.log(`  ✓ Inserted ${routeTrains.length} route-train links`);
    
    saveDatabase();
    console.log('✓ Database seeded successfully');
}

// Save database to file
function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
}

// Route CRUD operations
const routeDb = {
    getAll: () => {
        const stmt = db.prepare('SELECT * FROM routes ORDER BY id DESC');
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    getById: (id) => {
        const stmt = db.prepare('SELECT * FROM routes WHERE id = ?');
        stmt.bind([id]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    create: (name, country, tsw_version = 3) => {
        db.run('INSERT INTO routes (name, country, tsw_version) VALUES (?, ?, ?)', [name, country, tsw_version]);
        saveDatabase();
        const lastId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        return { lastInsertRowid: lastId };
    },
    update: (id, name, country, tsw_version) => {
        db.run('UPDATE routes SET name = ?, country = ?, tsw_version = ? WHERE id = ?', [name, country, tsw_version, id]);
        saveDatabase();
    },
    delete: (id) => {
        db.run('DELETE FROM routes WHERE id = ?', [id]);
        saveDatabase();
    },
    getTrains: (routeId) => {
        const stmt = db.prepare(`
            SELECT t.* FROM trains t
            INNER JOIN route_trains rt ON t.id = rt.train_id
            WHERE rt.route_id = ?
            ORDER BY t.name
        `);
        stmt.bind([routeId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    addTrain: (routeId, trainId) => {
        db.run('INSERT OR IGNORE INTO route_trains (route_id, train_id) VALUES (?, ?)', [routeId, trainId]);
        saveDatabase();
    },
    removeTrain: (routeId, trainId) => {
        db.run('DELETE FROM route_trains WHERE route_id = ? AND train_id = ?', [routeId, trainId]);
        saveDatabase();
    }
};

// Train CRUD operations
const trainDb = {
    getAll: () => {
        const stmt = db.prepare('SELECT * FROM trains ORDER BY name');
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    getById: (id) => {
        const stmt = db.prepare('SELECT * FROM trains WHERE id = ?');
        stmt.bind([id]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    getByName: (name) => {
        const stmt = db.prepare('SELECT * FROM trains WHERE name = ?');
        stmt.bind([name]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    create: (name) => {
        db.run('INSERT INTO trains (name) VALUES (?)', [name]);
        saveDatabase();
        const lastId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        return { lastInsertRowid: lastId };
    },
    update: (id, name) => {
        db.run('UPDATE trains SET name = ? WHERE id = ?', [name, id]);
        saveDatabase();
    },
    delete: (id) => {
        db.run('DELETE FROM trains WHERE id = ?', [id]);
        saveDatabase();
    },
    getRoutes: (trainId) => {
        const stmt = db.prepare(`
            SELECT r.* FROM routes r
            INNER JOIN route_trains rt ON r.id = rt.route_id
            WHERE rt.train_id = ?
            ORDER BY r.name
        `);
        stmt.bind([trainId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    }
};

// Timetable CRUD operations
const timetableDb = {
    getAll: () => {
        const stmt = db.prepare('SELECT * FROM timetables ORDER BY id DESC');
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    getById: (id) => {
        const stmt = db.prepare('SELECT * FROM timetables WHERE id = ?');
        stmt.bind([id]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    create: (serviceName) => {
        db.run('INSERT INTO timetables (service_name) VALUES (?)', [serviceName]);
        // Get the ID immediately after insert, before saveDatabase
        const result = db.exec('SELECT last_insert_rowid() as id');
        console.log('last_insert_rowid result:', JSON.stringify(result));
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        console.log('Parsed lastId:', lastId);
        saveDatabase();
        return { lastInsertRowid: lastId };
    },
    update: (id, serviceName) => {
        db.run('UPDATE timetables SET service_name = ? WHERE id = ?', [serviceName, id]);
        saveDatabase();
    },
    delete: (id) => {
        db.run('DELETE FROM timetable_entries WHERE timetable_id = ?', [id]);
        db.run('DELETE FROM timetables WHERE id = ?', [id]);
        saveDatabase();
    }
};

// Timetable entries operations
const entryDb = {
    getByTimetableId: (timetableId) => {
        const stmt = db.prepare('SELECT * FROM timetable_entries WHERE timetable_id = ? ORDER BY sort_order');
        stmt.bind([timetableId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    create: (timetableId, entry, sortOrder) => {
        console.log(`  -> INSERT timetable_entries: timetable_id=${timetableId}, action=${entry.action}, sort_order=${sortOrder}`);
        db.run(
            'INSERT INTO timetable_entries (timetable_id, action, details, location, platform, time1, time2, latitude, longitude, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [timetableId, entry.action, entry.details || '', entry.location || '', entry.platform || '', entry.time1 || '', entry.time2 || '', entry.latitude || '', entry.longitude || '', sortOrder]
        );
        // Get the ID immediately after insert, before saveDatabase
        const result = db.exec('SELECT last_insert_rowid() as id');
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        saveDatabase();
        
        // Verify what was actually inserted
        const verify = db.exec(`SELECT id, timetable_id, action FROM timetable_entries WHERE id = ${lastId}`);
        console.log(`  -> VERIFY inserted row:`, verify[0]?.values[0]);
        
        return { lastInsertRowid: lastId };
    },
    update: (id, entry) => {
        db.run(
            'UPDATE timetable_entries SET action = ?, details = ?, location = ?, platform = ?, time1 = ?, time2 = ?, latitude = ?, longitude = ? WHERE id = ?',
            [entry.action, entry.details || '', entry.location || '', entry.platform || '', entry.time1 || '', entry.time2 || '', entry.latitude || '', entry.longitude || '', id]
        );
        saveDatabase();
    },
    delete: (id) => {
        db.run('DELETE FROM timetable_entries WHERE id = ?', [id]);
        saveDatabase();
    }
};

/**
 * Gets the internal IP address of this machine
 */
function getInternalIpAddress() {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4;
            if (net.family === familyV4Value && !net.internal) {
                return net.address;
            }
        }
    }
    return 'localhost';
}

/**
 * Parse JSON body from request
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

/**
 * Parse raw body as buffer
 */
function parseRawBody(req, maxSize = MAX_UPLOAD_SIZE) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                req.destroy();
                reject(new Error('Upload too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/**
 * Parse multipart form data
 */
async function parseMultipart(req) {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
        throw new Error('No boundary found in content-type');
    }
    
    const boundary = boundaryMatch[1];
    const body = await parseRawBody(req);
    
    const parts = [];
    const boundaryBuffer = Buffer.from('--' + boundary);
    const endBoundaryBuffer = Buffer.from('--' + boundary + '--');
    
    let start = body.indexOf(boundaryBuffer) + boundaryBuffer.length + 2; // skip boundary + CRLF
    
    while (start < body.length) {
        const nextBoundary = body.indexOf(boundaryBuffer, start);
        if (nextBoundary === -1) break;
        
        const partData = body.slice(start, nextBoundary - 2); // -2 for CRLF before boundary
        
        // Split headers from content
        const headerEnd = partData.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
            start = nextBoundary + boundaryBuffer.length + 2;
            continue;
        }
        
        const headers = partData.slice(0, headerEnd).toString();
        const content = partData.slice(headerEnd + 4);
        
        // Parse Content-Disposition
        const dispositionMatch = headers.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/);
        if (dispositionMatch) {
            parts.push({
                name: dispositionMatch[1],
                filename: dispositionMatch[2] || null,
                data: content
            });
        }
        
        // Check if this is the end boundary
        if (body.indexOf(endBoundaryBuffer, nextBoundary) === nextBoundary) {
            break;
        }
        
        start = nextBoundary + boundaryBuffer.length + 2;
    }
    
    return parts;
}

/**
 * Send JSON response
 */
function sendJson(res, data, statusCode = 200) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * Serve static file
 */
function serveFile(res, filePath, contentType) {
    // Try appDir first (for compiled exe), then __dirname (for dev)
    let fullPath = path.join(appDir, 'public', filePath);
    if (!fs.existsSync(fullPath)) {
        fullPath = path.join(__dirname, 'public', filePath);
    }
    if (fs.existsSync(fullPath)) {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(fs.readFileSync(fullPath));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
}

/**
 * Main request handler
 */
async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    console.log(`${method} ${pathname}`);

    // Serve index page
    if (pathname === '/' || pathname === '/index.html') {
        serveFile(res, 'index.html', 'text/html');
        return;
    }
    
    // Serve extract page
    if (pathname === '/extract' || pathname === '/extract.html') {
        serveFile(res, 'extract.html', 'text/html');
        return;
    }

    // API Routes
    if (pathname === '/api/routes') {
        if (method === 'GET') {
            const routes = routeDb.getAll();
            sendJson(res, routes);
            return;
        }
        if (method === 'POST') {
            const body = await parseBody(req);
            const result = routeDb.create(body.name, body.country, body.tsw_version || 3);
            sendJson(res, { id: result.lastInsertRowid, name: body.name, country: body.country, tsw_version: body.tsw_version || 3 }, 201);
            return;
        }
    }

    // Single route operations
    const routeMatch = pathname.match(/^\/api\/routes\/(\d+)$/);
    if (routeMatch) {
        const id = parseInt(routeMatch[1]);
        
        if (method === 'GET') {
            const route = routeDb.getById(id);
            if (route) {
                sendJson(res, route);
            } else {
                sendJson(res, { error: 'Route not found' }, 404);
            }
            return;
        }
        if (method === 'PUT') {
            const body = await parseBody(req);
            routeDb.update(id, body.name, body.country, body.tsw_version);
            sendJson(res, { id, name: body.name, country: body.country, tsw_version: body.tsw_version });
            return;
        }
        if (method === 'DELETE') {
            routeDb.delete(id);
            sendJson(res, { success: true });
            return;
        }
    }

    // Route trains API
    const routeTrainsMatch = pathname.match(/^\/api\/routes\/(\d+)\/trains$/);
    if (routeTrainsMatch) {
        const routeId = parseInt(routeTrainsMatch[1]);
        
        if (method === 'GET') {
            const trains = routeDb.getTrains(routeId);
            sendJson(res, trains);
            return;
        }
        if (method === 'POST') {
            const body = await parseBody(req);
            routeDb.addTrain(routeId, body.train_id);
            sendJson(res, { success: true }, 201);
            return;
        }
        if (method === 'DELETE') {
            const body = await parseBody(req);
            routeDb.removeTrain(routeId, body.train_id);
            sendJson(res, { success: true });
            return;
        }
    }

    // Trains API
    if (pathname === '/api/trains') {
        if (method === 'GET') {
            const trains = trainDb.getAll();
            sendJson(res, trains);
            return;
        }
        if (method === 'POST') {
            const body = await parseBody(req);
            const result = trainDb.create(body.name);
            sendJson(res, { id: result.lastInsertRowid, name: body.name }, 201);
            return;
        }
    }

    // Single train operations
    const trainMatch = pathname.match(/^\/api\/trains\/(\d+)$/);
    if (trainMatch) {
        const id = parseInt(trainMatch[1]);
        
        if (method === 'GET') {
            const train = trainDb.getById(id);
            if (train) {
                sendJson(res, train);
            } else {
                sendJson(res, { error: 'Train not found' }, 404);
            }
            return;
        }
        if (method === 'PUT') {
            const body = await parseBody(req);
            trainDb.update(id, body.name);
            sendJson(res, { id, name: body.name });
            return;
        }
        if (method === 'DELETE') {
            trainDb.delete(id);
            sendJson(res, { success: true });
            return;
        }
    }

    // Train routes API (get routes for a train)
    const trainRoutesMatch = pathname.match(/^\/api\/trains\/(\d+)\/routes$/);
    if (trainRoutesMatch) {
        const trainId = parseInt(trainRoutesMatch[1]);
        
        if (method === 'GET') {
            const routes = trainDb.getRoutes(trainId);
            sendJson(res, routes);
            return;
        }
    }

    // Timetables API
    if (pathname === '/api/timetables') {
        if (method === 'GET') {
            const timetables = timetableDb.getAll();
            sendJson(res, timetables);
            return;
        }
        if (method === 'POST') {
            const body = await parseBody(req);
            console.log('=== CREATE TIMETABLE ===');
            console.log('Body received:', JSON.stringify(body, null, 2));
            
            // Step 1: Create the timetable
            const serviceName = body.service_name || 'Untitled';
            const result = timetableDb.create(serviceName);
            const timetableId = result.lastInsertRowid;
            console.log('Timetable created with ID:', timetableId);
            
            // Step 2: Create all entries if provided
            const savedEntries = [];
            if (body.entries && Array.isArray(body.entries)) {
                console.log(`Creating ${body.entries.length} entries...`);
                body.entries.forEach((entry, index) => {
                    const entryResult = entryDb.create(timetableId, entry, index);
                    console.log(`Entry ${index + 1} created with ID: ${entryResult.lastInsertRowid}, timetable_id: ${timetableId}`);
                    savedEntries.push({
                        id: entryResult.lastInsertRowid,
                        timetable_id: timetableId,
                        action: entry.action || '',
                        details: entry.details || '',
                        location: entry.location || '',
                        platform: entry.platform || '',
                        time1: entry.time1 || '',
                        time2: entry.time2 || '',
                        latitude: entry.latitude || '',
                        longitude: entry.longitude || '',
                        sort_order: index
                    });
                });
            }
            
            console.log('=== TIMETABLE CREATION COMPLETE ===');
            sendJson(res, { 
                id: timetableId, 
                service_name: serviceName,
                entries: savedEntries
            }, 201);
            return;
        }
    }

    // Single timetable operations
    const timetableMatch = pathname.match(/^\/api\/timetables\/(\d+)$/);
    if (timetableMatch) {
        const id = parseInt(timetableMatch[1]);
        
        if (method === 'GET') {
            const timetable = timetableDb.getById(id);
            if (timetable) {
                timetable.entries = entryDb.getByTimetableId(id);
                sendJson(res, timetable);
            } else {
                sendJson(res, { error: 'Timetable not found' }, 404);
            }
            return;
        }
        if (method === 'PUT') {
            const body = await parseBody(req);
            console.log('=== SAVE: Updating timetable ===');
            console.log('Timetable ID:', id);
            console.log('Body received:', JSON.stringify(body, null, 2));
            timetableDb.update(id, body.service_name);
            sendJson(res, { id, service_name: body.service_name });
            return;
        }
        if (method === 'DELETE') {
            timetableDb.delete(id);
            sendJson(res, { success: true });
            return;
        }
    }

    // Timetable entries API
    const entriesMatch = pathname.match(/^\/api\/timetables\/(\d+)\/entries$/);
    if (entriesMatch) {
        const timetableId = parseInt(entriesMatch[1]);
        console.log('=== ENTRIES API ===');
        console.log('timetableId from URL:', timetableId);
        
        if (method === 'GET') {
            const entries = entryDb.getByTimetableId(timetableId);
            sendJson(res, entries);
            return;
        }
        if (method === 'POST') {
            const body = await parseBody(req);
            console.log('Creating entry with timetableId:', timetableId);
            console.log('Entry body:', JSON.stringify(body, null, 2));
            const entries = entryDb.getByTimetableId(timetableId);
            const sortOrder = entries.length;
            const result = entryDb.create(timetableId, body, sortOrder);
            console.log('Entry created with id:', result.lastInsertRowid);
            sendJson(res, { id: result.lastInsertRowid, timetable_id: timetableId, ...body }, 201);
            return;
        }
    }

    // Single entry operations
    const entryMatch = pathname.match(/^\/api\/entries\/(\d+)$/);
    if (entryMatch) {
        const id = parseInt(entryMatch[1]);
        
        if (method === 'PUT') {
            const body = await parseBody(req);
            console.log('=== SAVE: Updating entry ===');
            console.log('Entry ID:', id);
            console.log('Body received:', JSON.stringify(body, null, 2));
            entryDb.update(id, body);
            sendJson(res, { id, ...body });
            return;
        }
        if (method === 'DELETE') {
            entryDb.delete(id);
            sendJson(res, { success: true });
            return;
        }
    }

    // Check OCR availability
    if (pathname === '/api/ocr-status' && method === 'GET') {
        sendJson(res, { available: ocrAvailable });
        return;
    }

    // OCR Upload and Process endpoint
    // NOTE: This endpoint only parses the images and returns data for review.
    // The user must click "Create Timetable" to save to the database.
    if (pathname === '/api/extract' && method === 'POST') {
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
            const entries = result.rows.map((row, index) => ({
                action: row.action,
                details: row.details || '',
                location: row.location || '',
                platform: row.platform || '',
                time1: row.time1 || '',
                time2: row.time2 || '',
                latitude: row.latitude || '',
                longitude: row.longitude || '',
                sort_order: index
            }));
            
            // Return parsed data without id (indicates not yet saved)
            const response = {
                service_name: result.serviceName || 'Extracted Timetable',
                entries: entries,
                rawTexts: result.rawTexts
            };
            
            sendJson(res, response, 200);
            return;
        } catch (error) {
            console.error('OCR error:', error);
            sendJson(res, { error: error.message }, 500);
            return;
        }
    }

    // 404 for everything else
    res.writeHead(404);
    res.end('Not Found');
}

// Create server
const server = http.createServer(handleRequest);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    if (db) {
        saveDatabase();
        db.close();
    }
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...');
    if (db) {
        saveDatabase();
        db.close();
    }
    server.close(() => {
        process.exit(0);
    });
});

// Initialize and start
async function start() {
    await initDatabase();
    await seedDatabase();
    const ip = getInternalIpAddress();

    server.listen(PORT, () => {
        console.log(`\n========================================`);
        console.log(`  TSW HUD Project Server`);
        console.log(`========================================`);
        console.log(`  Local:   http://localhost:${PORT}`);
        console.log(`  Network: http://${ip}:${PORT}`);
        console.log(`========================================`);
        console.log(`  Press Ctrl+C to stop`);
        console.log(`========================================\n`);
    });
}

start();