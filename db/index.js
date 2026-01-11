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

    // Countries table
    db.run(`
        CREATE TABLE IF NOT EXISTS countries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            code TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            country TEXT NOT NULL,
            country_id INTEGER,
            tsw_version INTEGER NOT NULL DEFAULT 3,
            FOREIGN KEY (country_id) REFERENCES countries(id) ON DELETE SET NULL
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

    // Add country_id column to routes if it doesn't exist (migration)
    try {
        db.run('ALTER TABLE routes ADD COLUMN country_id INTEGER REFERENCES countries(id) ON DELETE SET NULL');
    } catch (e) { /* column already exists */ }

    // Weather presets table
    db.run(`
        CREATE TABLE IF NOT EXISTS weather_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            temperature REAL NOT NULL DEFAULT 20,
            cloudiness REAL NOT NULL DEFAULT 0,
            precipitation REAL NOT NULL DEFAULT 0,
            wetness REAL NOT NULL DEFAULT 0,
            ground_snow REAL NOT NULL DEFAULT 0,
            piled_snow REAL NOT NULL DEFAULT 0,
            fog_density REAL NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Timetable coordinates table - stores GPS coordinates for a timetable recording
    db.run(`
        CREATE TABLE IF NOT EXISTS timetable_coordinates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timetable_id INTEGER NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            height REAL,
            gradient REAL,
            sort_order INTEGER NOT NULL,
            FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
        )
    `);

    // Timetable markers table - stores markers discovered during a timetable recording
    db.run(`
        CREATE TABLE IF NOT EXISTS timetable_markers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timetable_id INTEGER NOT NULL,
            station_name TEXT NOT NULL,
            marker_type TEXT,
            latitude REAL,
            longitude REAL,
            platform_length REAL,
            is_timetable_station INTEGER DEFAULT 0,
            FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
        )
    `);

    // Station name mappings table - maps display names to API names
    // Can be route-specific or global (route_id = NULL)
    db.run(`
        CREATE TABLE IF NOT EXISTS station_name_mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER,
            display_name TEXT NOT NULL,
            api_name TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
            UNIQUE(route_id, display_name)
        )
    `);

    // Create index for faster coordinate lookups
    try {
        db.run('CREATE INDEX IF NOT EXISTS idx_timetable_coordinates_timetable_id ON timetable_coordinates(timetable_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_timetable_markers_timetable_id ON timetable_markers(timetable_id)');
    } catch (e) { /* indexes may already exist */ }

    // Seed default countries
    seedCountries();

    // Migrate existing country text values to countries table
    migrateCountries();

    // Seed default weather presets
    seedWeatherPresets();

    saveDatabase();
    console.log('✓ Database initialized');
}

// Seed default weather presets
function seedWeatherPresets() {
    const presetCount = db.exec('SELECT COUNT(*) FROM weather_presets')[0]?.values[0][0] || 0;
    if (presetCount > 0) {
        return; // Already seeded
    }

    console.log('Seeding weather presets...');

    // Sunny Day preset
    db.run(`INSERT INTO weather_presets (name, temperature, cloudiness, precipitation, wetness, ground_snow, piled_snow, fog_density)
            VALUES ('Sunny Day', 25, 0.1, 0, 0, 0, 0, 0)`);

    // Snowy Day preset
    db.run(`INSERT INTO weather_presets (name, temperature, cloudiness, precipitation, wetness, ground_snow, piled_snow, fog_density)
            VALUES ('Snowy Day', -5, 0.8, 0.7, 0.3, 0.8, 0.6, 0.2)`);

    // Rainy Day preset
    db.run(`INSERT INTO weather_presets (name, temperature, cloudiness, precipitation, wetness, ground_snow, piled_snow, fog_density)
            VALUES ('Rainy Day', 12, 0.9, 0.8, 0.7, 0, 0, 0.3)`);

    console.log('✓ Weather presets seeded');
}

// Seed default countries
function seedCountries() {
    const countryCount = db.exec('SELECT COUNT(*) FROM countries')[0]?.values[0][0] || 0;
    if (countryCount > 0) {
        return; // Already seeded
    }

    console.log('Seeding countries...');

    const countries = [
        { name: 'United Kingdom', code: 'GB' },
        { name: 'Germany', code: 'DE' },
        { name: 'United States', code: 'US' },
        { name: 'France', code: 'FR' },
        { name: 'Austria', code: 'AT' },
        { name: 'Switzerland', code: 'CH' },
        { name: 'Netherlands', code: 'NL' },
        { name: 'Ireland', code: 'IE' },
        { name: 'Canada', code: 'CA' },
        { name: 'Italy', code: 'IT' }
    ];

    for (const country of countries) {
        db.run('INSERT INTO countries (name, code) VALUES (?, ?)', [country.name, country.code]);
    }

    console.log(`✓ ${countries.length} countries seeded`);
}

// Migrate existing country text values to countries table and link routes
function migrateCountries() {
    // Get all unique countries from routes
    const countriesResult = db.exec('SELECT DISTINCT country FROM routes WHERE country IS NOT NULL AND country != ""');
    if (countriesResult.length === 0 || countriesResult[0].values.length === 0) {
        return;
    }

    const existingCountries = db.exec('SELECT COUNT(*) FROM countries');
    if (existingCountries[0].values[0][0] > 0) {
        // Countries already migrated
        return;
    }

    console.log('Migrating countries...');

    // Insert unique countries
    for (const row of countriesResult[0].values) {
        const countryName = row[0];
        if (countryName) {
            try {
                db.run('INSERT OR IGNORE INTO countries (name) VALUES (?)', [countryName]);
            } catch (e) { /* ignore duplicates */ }
        }
    }

    // Update routes to reference country_id
    const countries = db.exec('SELECT id, name FROM countries');
    if (countries.length > 0) {
        for (const row of countries[0].values) {
            const countryId = row[0];
            const countryName = row[1];
            db.run('UPDATE routes SET country_id = ? WHERE country = ?', [countryId, countryName]);
        }
    }

    console.log('✓ Countries migrated');
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

    // Seed station name mappings after routes are seeded
    seedStationMappings();
}

// Seed station name mappings from JSON file
function seedStationMappings() {
    const mappingsFile = path.join(__dirname, 'seed_station_mappings.json');

    if (!fs.existsSync(mappingsFile)) {
        console.log('⚠ Station mappings seed file not found, skipping');
        return;
    }

    // Check if already seeded
    const mappingCount = db.exec('SELECT COUNT(*) FROM station_name_mappings')[0]?.values[0][0] || 0;
    if (mappingCount > 0) {
        console.log(`✓ Database already has ${mappingCount} station mappings, skipping seed`);
        return;
    }

    console.log('Seeding station name mappings...');

    const mappings = JSON.parse(fs.readFileSync(mappingsFile, 'utf8'));

    // Group by route name and look up route IDs
    const routeCache = {};
    let insertedCount = 0;

    for (const mapping of mappings) {
        let routeId = null;

        if (mapping.route_name) {
            // Look up route ID by name (use cache to avoid repeated queries)
            if (!(mapping.route_name in routeCache)) {
                const result = db.exec('SELECT id FROM routes WHERE name = ?', [mapping.route_name]);
                routeCache[mapping.route_name] = result.length > 0 && result[0].values.length > 0
                    ? result[0].values[0][0]
                    : null;
            }
            routeId = routeCache[mapping.route_name];

            if (routeId === null) {
                console.log(`  ⚠ Route not found: "${mapping.route_name}", skipping mapping`);
                continue;
            }
        }

        // Insert the mapping
        db.run(
            'INSERT INTO station_name_mappings (route_id, display_name, api_name) VALUES (?, ?, ?)',
            [routeId, mapping.display_name, mapping.api_name]
        );
        insertedCount++;
    }

    saveDatabase();
    console.log(`  ✓ Inserted ${insertedCount} station name mappings`);
}

// Save database to file
function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
}

// Country CRUD operations
const countryDb = {
    getAll: () => {
        const stmt = db.prepare('SELECT * FROM countries ORDER BY name');
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    getById: (id) => {
        const stmt = db.prepare('SELECT * FROM countries WHERE id = ?');
        stmt.bind([id]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    getByName: (name) => {
        const stmt = db.prepare('SELECT * FROM countries WHERE name = ?');
        stmt.bind([name]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    create: (name, code = null) => {
        db.run('INSERT INTO countries (name, code) VALUES (?, ?)', [name, code]);
        const result = db.exec('SELECT last_insert_rowid() as id');
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        saveDatabase();
        return { lastInsertRowid: lastId };
    },
    update: (id, name, code = null) => {
        db.run('UPDATE countries SET name = ?, code = ? WHERE id = ?', [name, code, id]);
        saveDatabase();
    },
    delete: (id) => {
        db.run('DELETE FROM countries WHERE id = ?', [id]);
        saveDatabase();
    },
    getRoutes: (countryId) => {
        const stmt = db.prepare('SELECT * FROM routes WHERE country_id = ? ORDER BY name');
        stmt.bind([countryId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    }
};

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
    getPaginated: (page = 1, limit = 10, search = '') => {
        const offset = (page - 1) * limit;
        let countQuery = 'SELECT COUNT(*) as total FROM routes';
        let dataQuery = 'SELECT * FROM routes';

        if (search) {
            const whereClause = ' WHERE name LIKE ? OR country LIKE ?';
            countQuery += whereClause;
            dataQuery += whereClause;
        }

        dataQuery += ' ORDER BY id DESC LIMIT ? OFFSET ?';

        // Get total count
        let total = 0;
        if (search) {
            const searchPattern = '%' + search + '%';
            const countResult = db.exec(countQuery, [searchPattern, searchPattern]);
            total = countResult.length > 0 ? countResult[0].values[0][0] : 0;
        } else {
            const countResult = db.exec(countQuery);
            total = countResult.length > 0 ? countResult[0].values[0][0] : 0;
        }

        // Get paginated data
        const stmt = db.prepare(dataQuery);
        if (search) {
            const searchPattern = '%' + search + '%';
            stmt.bind([searchPattern, searchPattern, limit, offset]);
        } else {
            stmt.bind([limit, offset]);
        }

        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();

        return {
            data: results,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
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
    create: (name, country, tsw_version = 3, country_id = null) => {
        db.run('INSERT INTO routes (name, country, tsw_version, country_id) VALUES (?, ?, ?, ?)', [name, country, tsw_version, country_id]);
        saveDatabase();
        const lastId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        return { lastInsertRowid: lastId };
    },
    update: (id, name, country, tsw_version, country_id = null) => {
        db.run('UPDATE routes SET name = ?, country = ?, tsw_version = ?, country_id = ? WHERE id = ?', [name, country, tsw_version, country_id, id]);
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
        // Get ID immediately after insert, before saveDatabase
        const result = db.exec('SELECT last_insert_rowid() as id');
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        saveDatabase();
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
    create: (serviceName, routeId = null, trainId = null) => {
        db.run('INSERT INTO timetables (service_name, route_id, train_id) VALUES (?, ?, ?)', [serviceName, routeId, trainId]);
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
            const obj = stmt.getAsObject();
            results.push(obj);
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

// Weather preset CRUD operations
const weatherPresetDb = {
    getAll: () => {
        const stmt = db.prepare('SELECT * FROM weather_presets ORDER BY name');
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    getById: (id) => {
        const stmt = db.prepare('SELECT * FROM weather_presets WHERE id = ?');
        stmt.bind([id]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    getByName: (name) => {
        const stmt = db.prepare('SELECT * FROM weather_presets WHERE name = ?');
        stmt.bind([name]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    create: (preset) => {
        db.run(
            `INSERT INTO weather_presets (name, temperature, cloudiness, precipitation, wetness, ground_snow, piled_snow, fog_density)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [preset.name, preset.temperature, preset.cloudiness, preset.precipitation, preset.wetness, preset.ground_snow, preset.piled_snow, preset.fog_density]
        );
        const result = db.exec('SELECT last_insert_rowid() as id');
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        saveDatabase();
        return { lastInsertRowid: lastId };
    },
    update: (id, preset) => {
        db.run(
            `UPDATE weather_presets SET name = ?, temperature = ?, cloudiness = ?, precipitation = ?, wetness = ?, ground_snow = ?, piled_snow = ?, fog_density = ? WHERE id = ?`,
            [preset.name, preset.temperature, preset.cloudiness, preset.precipitation, preset.wetness, preset.ground_snow, preset.piled_snow, preset.fog_density, id]
        );
        saveDatabase();
    },
    delete: (id) => {
        db.run('DELETE FROM weather_presets WHERE id = ?', [id]);
        saveDatabase();
    }
};

// Timetable coordinates CRUD operations
const timetableCoordinateDb = {
    getByTimetableId: (timetableId) => {
        const stmt = db.prepare('SELECT * FROM timetable_coordinates WHERE timetable_id = ? ORDER BY sort_order');
        stmt.bind([timetableId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    getCount: (timetableId) => {
        const result = db.exec('SELECT COUNT(*) FROM timetable_coordinates WHERE timetable_id = ?', [timetableId]);
        return result.length > 0 ? result[0].values[0][0] : 0;
    },
    deleteByTimetableId: (timetableId) => {
        db.run('DELETE FROM timetable_coordinates WHERE timetable_id = ?', [timetableId]);
        saveDatabase();
    },
    bulkInsert: (timetableId, coordinates) => {
        // Delete existing coordinates first
        db.run('DELETE FROM timetable_coordinates WHERE timetable_id = ?', [timetableId]);

        // Insert new coordinates
        const stmt = db.prepare('INSERT INTO timetable_coordinates (timetable_id, latitude, longitude, height, gradient, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
        for (let i = 0; i < coordinates.length; i++) {
            const coord = coordinates[i];
            stmt.run([timetableId, coord.latitude, coord.longitude, coord.height || null, coord.gradient || null, i]);
        }
        stmt.free();
        saveDatabase();
        return coordinates.length;
    }
};

// Timetable markers CRUD operations
const timetableMarkerDb = {
    getByTimetableId: (timetableId) => {
        const stmt = db.prepare('SELECT * FROM timetable_markers WHERE timetable_id = ? ORDER BY id');
        stmt.bind([timetableId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    getCount: (timetableId) => {
        const result = db.exec('SELECT COUNT(*) FROM timetable_markers WHERE timetable_id = ?', [timetableId]);
        return result.length > 0 ? result[0].values[0][0] : 0;
    },
    deleteByTimetableId: (timetableId) => {
        db.run('DELETE FROM timetable_markers WHERE timetable_id = ?', [timetableId]);
        saveDatabase();
    },
    bulkInsert: (timetableId, markers) => {
        // Delete existing markers first
        db.run('DELETE FROM timetable_markers WHERE timetable_id = ?', [timetableId]);

        // Insert new markers
        const stmt = db.prepare('INSERT INTO timetable_markers (timetable_id, station_name, marker_type, latitude, longitude, platform_length, is_timetable_station) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const marker of markers) {
            stmt.run([
                timetableId,
                marker.stationName || marker.station_name,
                marker.markerType || marker.marker_type || 'Station',
                marker.latitude || null,
                marker.longitude || null,
                marker.platformLength || marker.platform_length || null,
                marker.isTimetableStation || marker.is_timetable_station ? 1 : 0
            ]);
        }
        stmt.free();
        saveDatabase();
        return markers.length;
    },
    update: (id, marker) => {
        db.run(
            'UPDATE timetable_markers SET station_name = ?, marker_type = ?, latitude = ?, longitude = ?, platform_length = ? WHERE id = ?',
            [
                marker.station_name || marker.stationName,
                marker.marker_type || marker.markerType || 'Station',
                marker.latitude || null,
                marker.longitude || null,
                marker.platform_length || marker.platformLength || null,
                id
            ]
        );
        saveDatabase();
    }
};

// Build complete timetable data from database (for map display)
const timetableDataDb = {
    // Get full timetable data with coordinates, markers, and entries
    getFullTimetableData: (timetableId) => {
        // Get timetable info
        const timetable = timetableDb.getById(timetableId);
        if (!timetable) return null;

        // Get coordinates for this timetable
        const coordinates = timetableCoordinateDb.getByTimetableId(timetableId);

        // Get markers for this timetable (discovered during recording - kept for future use)
        const markers = timetableMarkerDb.getByTimetableId(timetableId);

        // Get timetable entries (stations from OCR) - these are the actual stops
        const entries = entryDb.getByTimetableId(timetableId);
        const timetableEntries = entries.map((entry, index) => ({
            index,
            destination: entry.location || entry.details || 'Unknown',
            arrival: entry.time1 || '',
            departure: entry.time2 || '',
            platform: entry.platform || '',
            apiName: entry.location || '',
            latitude: entry.latitude ? parseFloat(entry.latitude) : null,
            longitude: entry.longitude ? parseFloat(entry.longitude) : null
        }));

        // Build the data object
        // - coordinates: GPS path for the route polyline
        // - markers: raw discovered markers from game API (kept for future use)
        // - timetable: the actual stations in stopping order (used for map display)
        return {
            routeName: timetable.service_name,
            timetableId: timetable.id,
            routeId: timetable.route_id,
            trainId: timetable.train_id,
            totalPoints: coordinates.length,
            totalMarkers: markers.length,
            coordinates: coordinates.map(c => ({
                latitude: c.latitude,
                longitude: c.longitude,
                height: c.height,
                gradient: c.gradient
            })),
            markers: markers.map(m => ({
                stationName: m.station_name,
                markerType: m.marker_type,
                latitude: m.latitude,
                longitude: m.longitude,
                platformLength: m.platform_length
            })),
            timetable: timetableEntries
        };
    },

    // Check if a timetable has coordinate data
    hasCoordinates: (timetableId) => {
        return timetableCoordinateDb.getCount(timetableId) > 0;
    },

    // Get timetables that have coordinate data
    getTimetablesWithCoordinates: () => {
        const stmt = db.prepare(`
            SELECT t.*,
                   (SELECT COUNT(*) FROM timetable_coordinates WHERE timetable_id = t.id) as coordinate_count,
                   (SELECT COUNT(*) FROM timetable_markers WHERE timetable_id = t.id) as marker_count
            FROM timetables t
            WHERE (SELECT COUNT(*) FROM timetable_coordinates WHERE timetable_id = t.id) > 0
            ORDER BY t.service_name
        `);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },

    // Get all timetables with coordinate counts
    getAllWithCounts: () => {
        const stmt = db.prepare(`
            SELECT t.*,
                   (SELECT COUNT(*) FROM timetable_coordinates WHERE timetable_id = t.id) as coordinate_count,
                   (SELECT COUNT(*) FROM timetable_markers WHERE timetable_id = t.id) as marker_count
            FROM timetables t
            ORDER BY t.id DESC
        `);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    }
};

// Station name mappings CRUD operations
const stationMappingDb = {
    // Get all mappings, optionally filtered by route
    getAll: (routeId = null) => {
        let query = 'SELECT * FROM station_name_mappings';
        const params = [];

        if (routeId !== null) {
            query += ' WHERE route_id = ? OR route_id IS NULL';
            params.push(routeId);
        }

        query += ' ORDER BY route_id NULLS FIRST, display_name';

        const stmt = db.prepare(query);
        if (params.length > 0) {
            stmt.bind(params);
        }
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },

    // Get a single mapping by ID
    getById: (id) => {
        const stmt = db.prepare('SELECT * FROM station_name_mappings WHERE id = ?');
        stmt.bind([id]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },

    // Get mappings for a specific route (includes global mappings where route_id is NULL)
    getByRouteId: (routeId) => {
        const stmt = db.prepare('SELECT * FROM station_name_mappings WHERE route_id = ? OR route_id IS NULL ORDER BY route_id NULLS FIRST, display_name');
        stmt.bind([routeId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },

    // Get mapping as a lookup object { displayName: apiName }
    getMappingObject: (routeId = null) => {
        const mappings = routeId !== null
            ? stationMappingDb.getByRouteId(routeId)
            : stationMappingDb.getAll();

        const result = {};
        for (const mapping of mappings) {
            result[mapping.display_name] = mapping.api_name;
        }
        return result;
    },

    // Create a new mapping
    create: (displayName, apiName, routeId = null) => {
        const result = db.run(
            'INSERT INTO station_name_mappings (display_name, api_name, route_id) VALUES (?, ?, ?)',
            [displayName, apiName, routeId]
        );
        saveDatabase();
        return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
    },

    // Update an existing mapping
    update: (id, displayName, apiName, routeId = null) => {
        db.run(
            'UPDATE station_name_mappings SET display_name = ?, api_name = ?, route_id = ? WHERE id = ?',
            [displayName, apiName, routeId, id]
        );
        saveDatabase();
    },

    // Delete a mapping
    delete: (id) => {
        db.run('DELETE FROM station_name_mappings WHERE id = ?', [id]);
        saveDatabase();
    },

    // Delete all mappings for a route
    deleteByRouteId: (routeId) => {
        db.run('DELETE FROM station_name_mappings WHERE route_id = ?', [routeId]);
        saveDatabase();
    },

    // Bulk insert mappings (useful for importing from JSON files)
    bulkInsert: (mappings, routeId = null) => {
        const stmt = db.prepare('INSERT OR REPLACE INTO station_name_mappings (display_name, api_name, route_id) VALUES (?, ?, ?)');
        for (const mapping of mappings) {
            stmt.run([
                mapping.display_name || mapping.displayName,
                mapping.api_name || mapping.apiName,
                mapping.route_id !== undefined ? mapping.route_id : routeId
            ]);
        }
        stmt.free();
        saveDatabase();
        return mappings.length;
    },

    // Import from a JSON object { displayName: apiName }
    importFromObject: (obj, routeId = null) => {
        const mappings = Object.entries(obj).map(([displayName, apiName]) => ({
            display_name: displayName,
            api_name: apiName,
            route_id: routeId
        }));
        return stationMappingDb.bulkInsert(mappings, routeId);
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
    seedStationMappings,
    saveDatabase,
    closeDatabase,
    countryDb,
    routeDb,
    trainDb,
    timetableDb,
    entryDb,
    weatherPresetDb,
    timetableCoordinateDb,
    timetableMarkerDb,
    timetableDataDb,
    stationMappingDb
};
