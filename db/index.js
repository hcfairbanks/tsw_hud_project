'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

// Get the directory where the exe is running from (works for both dev and compiled)
const appDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

// Database setup - always use the db folder
const projectRoot = process.pkg ? path.dirname(path.dirname(process.execPath)) : path.join(__dirname, '..');
const dbPath = path.join(__dirname, 'tsw_hud.db');
let db = null;

console.log(`Database location: ${dbPath}`);

// Initialize database
async function initDatabase() {
    // Locate the wasm file - check multiple locations
    const wasmPaths = [
        path.join(appDir, 'sql-wasm.wasm'),
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
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
    const routesFile = path.join(__dirname, 'seed_routes.json');
    const trainsFile = path.join(__dirname, 'seed_trains.json');
    const routeTrainsFile = path.join(__dirname, 'seed_route_trains.json');
    
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

// Close database connection
function closeDatabase() {
    if (db) {
        saveDatabase();
        db.close();
        db = null;
        console.log('Database closed.');
    }
}

module.exports = {
    initDatabase,
    seedDatabase,
    saveDatabase,
    closeDatabase,
    routeDb,
    trainDb,
    timetableDb,
    entryDb
};
