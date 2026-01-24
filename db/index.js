'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

// Time format validation helper (HH:MM:SS)
const TIME_FORMAT_REGEX = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/;

function isValidTimeFormat(time) {
    if (!time || time.trim() === '') return true; // Empty is allowed
    return TIME_FORMAT_REGEX.test(time);
}

function validateTimeFormat(time, fieldName) {
    if (time && time.trim() !== '' && !isValidTimeFormat(time)) {
        throw new Error(`Invalid time format for ${fieldName}: "${time}". Must be HH:MM:SS (e.g., 08:30:00)`);
    }
}

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
            name TEXT NOT NULL UNIQUE,
            country_id INTEGER NOT NULL,
            tsw_version INTEGER NOT NULL DEFAULT 3,
            FOREIGN KEY (country_id) REFERENCES countries(id) ON DELETE RESTRICT
        )
    `);

    // Add UNIQUE constraint to routes.name if it doesn't exist (migration for existing databases)
    try {
        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_name ON routes(name)');
    } catch (e) { /* index may already exist */ }
    
    // Train classes table - groups trains by class
    db.run(`
        CREATE TABLE IF NOT EXISTS train_classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
    `);

    // Trains table - now with class_id
    db.run(`
        CREATE TABLE IF NOT EXISTS trains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            class_id INTEGER,
            FOREIGN KEY (class_id) REFERENCES train_classes(id) ON DELETE SET NULL
        )
    `);

    // Add class_id column to trains if it doesn't exist (migration for existing databases)
    try {
        db.run('ALTER TABLE trains ADD COLUMN class_id INTEGER REFERENCES train_classes(id) ON DELETE SET NULL');
    } catch (e) { /* column already exists */ }

    // Route-Train junction table (many-to-many) - kept for backward compatibility during migration
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

    // Route-TrainClass junction table (routes have train classes)
    db.run(`
        CREATE TABLE IF NOT EXISTS route_train_classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL,
            FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
            FOREIGN KEY (class_id) REFERENCES train_classes(id) ON DELETE CASCADE,
            UNIQUE(route_id, class_id)
        )
    `);

    // Timetables table - stores parsed timetable sessions (train_id removed, now in timetable_trains)
    db.run(`
        CREATE TABLE IF NOT EXISTS timetables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_name TEXT NOT NULL UNIQUE,
            route_id INTEGER,
            train_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE SET NULL,
            FOREIGN KEY (train_id) REFERENCES trains(id) ON DELETE SET NULL
        )
    `);

    // Timetable-Train junction table (timetables can have multiple trains)
    db.run(`
        CREATE TABLE IF NOT EXISTS timetable_trains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timetable_id INTEGER NOT NULL,
            train_id INTEGER NOT NULL,
            FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE,
            FOREIGN KEY (train_id) REFERENCES trains(id) ON DELETE CASCADE,
            UNIQUE(timetable_id, train_id)
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
            api_name TEXT,
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
    try {
        db.run('ALTER TABLE timetable_entries ADD COLUMN api_name TEXT');
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

    // Migration: Migrate existing data to new train class structure
    migrateToTrainClasses();

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

    // Timetable coordinates table - stores GPS coordinates as JSON string
    db.run(`
        CREATE TABLE IF NOT EXISTS timetable_coordinates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timetable_id INTEGER NOT NULL UNIQUE,
            coordinates TEXT NOT NULL,
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

    // Seed default weather presets
    seedWeatherPresets();

    saveDatabase();
    console.log('✓ Database initialized');
}

// Migrate existing data to train class structure
function migrateToTrainClasses() {
    // Check if migration is needed by looking for train_classes table with data
    const classCount = db.exec('SELECT COUNT(*) FROM train_classes')[0]?.values[0][0] || 0;
    const trainCount = db.exec('SELECT COUNT(*) FROM trains')[0]?.values[0][0] || 0;

    if (classCount > 0 || trainCount === 0) {
        // Already migrated or no data to migrate
        return;
    }

    console.log('Migrating to train class structure...');

    // Step 1: Create train classes from existing trains (each train becomes its own class)
    const trains = db.exec('SELECT id, name FROM trains');
    if (trains.length > 0 && trains[0].values.length > 0) {
        const insertClassStmt = db.prepare('INSERT INTO train_classes (id, name) VALUES (?, ?)');
        const updateTrainStmt = db.prepare('UPDATE trains SET class_id = ? WHERE id = ?');

        for (const [id, name] of trains[0].values) {
            insertClassStmt.run([id, name]);
            updateTrainStmt.run([id, id]); // Set class_id = id (train's own class)
        }
        insertClassStmt.free();
        updateTrainStmt.free();
        console.log(`  ✓ Created ${trains[0].values.length} train classes from existing trains`);
    }

    // Step 2: Migrate route_trains to route_train_classes
    const routeTrains = db.exec('SELECT DISTINCT route_id, train_id FROM route_trains');
    if (routeTrains.length > 0 && routeTrains[0].values.length > 0) {
        const insertRTCStmt = db.prepare('INSERT OR IGNORE INTO route_train_classes (route_id, class_id) VALUES (?, ?)');
        for (const [routeId, trainId] of routeTrains[0].values) {
            // train_id = class_id since we created classes with same IDs as trains
            insertRTCStmt.run([routeId, trainId]);
        }
        insertRTCStmt.free();
        console.log(`  ✓ Migrated route-train relationships to route-train-class`);
    }

    // Step 3: Migrate timetable train_id to timetable_trains junction table
    const timetables = db.exec('SELECT id, train_id FROM timetables WHERE train_id IS NOT NULL');
    if (timetables.length > 0 && timetables[0].values.length > 0) {
        const insertTTStmt = db.prepare('INSERT OR IGNORE INTO timetable_trains (timetable_id, train_id) VALUES (?, ?)');
        for (const [timetableId, trainId] of timetables[0].values) {
            insertTTStmt.run([timetableId, trainId]);
        }
        insertTTStmt.free();
        console.log(`  ✓ Migrated timetable-train relationships to junction table`);
    }

    saveDatabase();
    console.log('✓ Train class migration complete');
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

// Seed database with routes and trains from JSON files
async function seedDatabase() {
    const routesFile = path.join(__dirname, 'seed_routes.json');
    const trainsFile = path.join(__dirname, 'seed_trains.json');
    const routeTrainsFile = path.join(__dirname, 'seed_route_trains.json');
    const trainClassesFile = path.join(__dirname, 'seed_train_classes.json');
    const routeTrainClassesFile = path.join(__dirname, 'seed_route_train_classes.json');

    if (!fs.existsSync(routesFile) || !fs.existsSync(trainsFile)) {
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

    // Insert train classes if seed file exists
    if (fs.existsSync(trainClassesFile)) {
        const trainClasses = JSON.parse(fs.readFileSync(trainClassesFile, 'utf8'));
        const classStmt = db.prepare('INSERT INTO train_classes (id, name) VALUES (?, ?)');
        for (const tc of trainClasses) {
            classStmt.run([tc.id, tc.name]);
        }
        classStmt.free();
        console.log(`  ✓ Inserted ${trainClasses.length} train classes`);
    }

    // Insert trains (with class_id if present)
    const trainStmt = db.prepare('INSERT INTO trains (id, name, class_id) VALUES (?, ?, ?)');
    for (const train of trains) {
        trainStmt.run([train.id, train.name, train.class_id || null]);
    }
    trainStmt.free();
    console.log(`  ✓ Inserted ${trains.length} trains`);

    // Insert routes
    const routeStmt = db.prepare('INSERT INTO routes (id, name, country_id, tsw_version) VALUES (?, ?, ?, ?)');
    for (const route of routes) {
        routeStmt.run([route.id, route.name, route.country_id, route.tsw_version]);
    }
    routeStmt.free();
    console.log(`  ✓ Inserted ${routes.length} routes`);

    // Insert route-train-class relationships if seed file exists
    if (fs.existsSync(routeTrainClassesFile)) {
        const routeTrainClasses = JSON.parse(fs.readFileSync(routeTrainClassesFile, 'utf8'));
        const rtcStmt = db.prepare('INSERT INTO route_train_classes (route_id, class_id) VALUES (?, ?)');
        for (const rtc of routeTrainClasses) {
            rtcStmt.run([rtc.route_id, rtc.class_id]);
        }
        rtcStmt.free();
        console.log(`  ✓ Inserted ${routeTrainClasses.length} route-train-class links`);
    }

    // Insert legacy route-train relationships (for backward compatibility)
    if (fs.existsSync(routeTrainsFile)) {
        const routeTrains = JSON.parse(fs.readFileSync(routeTrainsFile, 'utf8'));
        const rtStmt = db.prepare('INSERT INTO route_trains (route_id, train_id) VALUES (?, ?)');
        for (const rt of routeTrains) {
            rtStmt.run([rt.route_id, rt.train_id]);
        }
        rtStmt.free();
        console.log(`  ✓ Inserted ${routeTrains.length} route-train links`);
    }

    saveDatabase();
    console.log('✓ Database seeded successfully');

    // Seed station name mappings after routes are seeded
    seedStationMappings();

    // Seed timetables after routes and trains are seeded
    seedTimetables();
}

// Seed timetables from JSON files
function seedTimetables() {
    const timetablesFile = path.join(__dirname, 'seed_timetables.json');
    const entriesFile = path.join(__dirname, 'seed_timetable_entries.json');
    const timetableTrainsFile = path.join(__dirname, 'seed_timetable_trains.json');

    if (!fs.existsSync(timetablesFile) || !fs.existsSync(entriesFile)) {
        console.log('⚠ Timetable seed files not found, skipping timetable seeding');
        return;
    }

    // Check if already seeded
    const timetableCount = db.exec('SELECT COUNT(*) as count FROM timetables')[0]?.values[0][0] || 0;
    if (timetableCount > 0) {
        console.log(`✓ Database already has ${timetableCount} timetables, skipping timetable seed`);
        return;
    }

    console.log('Seeding timetables...');

    const timetables = JSON.parse(fs.readFileSync(timetablesFile, 'utf8'));
    const entries = JSON.parse(fs.readFileSync(entriesFile, 'utf8'));

    // Insert timetables (train_id kept for backward compatibility during migration)
    const ttStmt = db.prepare('INSERT INTO timetables (id, service_name, route_id, train_id) VALUES (?, ?, ?, ?)');
    for (const tt of timetables) {
        ttStmt.run([tt.id, tt.service_name, tt.route_id, tt.train_id || null]);
    }
    ttStmt.free();
    console.log(`  ✓ Inserted ${timetables.length} timetables`);

    // Insert timetable-train relationships if seed file exists
    if (fs.existsSync(timetableTrainsFile)) {
        const timetableTrains = JSON.parse(fs.readFileSync(timetableTrainsFile, 'utf8'));
        const ttTrainStmt = db.prepare('INSERT INTO timetable_trains (timetable_id, train_id) VALUES (?, ?)');
        for (const ttt of timetableTrains) {
            ttTrainStmt.run([ttt.timetable_id, ttt.train_id]);
        }
        ttTrainStmt.free();
        console.log(`  ✓ Inserted ${timetableTrains.length} timetable-train links`);
    } else {
        // Fallback: create timetable_trains from timetable.train_id
        for (const tt of timetables) {
            if (tt.train_id) {
                db.run('INSERT INTO timetable_trains (timetable_id, train_id) VALUES (?, ?)', [tt.id, tt.train_id]);
            }
        }
        console.log(`  ✓ Created timetable-train links from timetable train_id`);
    }

    // Insert timetable entries
    const entryStmt = db.prepare('INSERT INTO timetable_entries (id, timetable_id, action, details, location, platform, time1, time2, latitude, longitude, sort_order, api_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const entry of entries) {
        entryStmt.run([
            entry.id,
            entry.timetable_id,
            entry.action,
            entry.details || '',
            entry.location || '',
            entry.platform || '',
            entry.time1 || '',
            entry.time2 || '',
            entry.latitude || '',
            entry.longitude || '',
            entry.sort_order,
            entry.api_name
        ]);
    }
    entryStmt.free();
    console.log(`  ✓ Inserted ${entries.length} timetable entries`);

    saveDatabase();
    console.log('✓ Timetables seeded successfully');
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
        console.log('countryDb.create last_insert_rowid result:', JSON.stringify(result));
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        console.log('countryDb.create returning lastId:', lastId);
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
    getPaginated: (page = 1, limit = 10, search = '', countryId = null) => {
        const offset = (page - 1) * limit;
        let countQuery = 'SELECT COUNT(*) as total FROM routes';
        let dataQuery = 'SELECT * FROM routes';
        const conditions = [];
        const countParams = [];
        const dataParams = [];

        if (search) {
            conditions.push('name LIKE ?');
            const searchPattern = '%' + search + '%';
            countParams.push(searchPattern);
            dataParams.push(searchPattern);
        }

        if (countryId) {
            conditions.push('country_id = ?');
            countParams.push(countryId);
            dataParams.push(countryId);
        }

        if (conditions.length > 0) {
            const whereClause = ' WHERE ' + conditions.join(' AND ');
            countQuery += whereClause;
            dataQuery += whereClause;
        }

        dataQuery += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        dataParams.push(limit, offset);

        // Get total count
        let total = 0;
        if (countParams.length > 0) {
            const countResult = db.exec(countQuery, countParams);
            total = countResult.length > 0 ? countResult[0].values[0][0] : 0;
        } else {
            const countResult = db.exec(countQuery);
            total = countResult.length > 0 ? countResult[0].values[0][0] : 0;
        }

        // Get paginated data
        const stmt = db.prepare(dataQuery);
        stmt.bind(dataParams);

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
    getByName: (name) => {
        const stmt = db.prepare('SELECT * FROM routes WHERE name = ?');
        stmt.bind([name]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    create: (name, country_id, tsw_version = 3) => {
        console.log('routeDb.create called with:', { name, country_id, tsw_version });
        db.run('INSERT INTO routes (name, country_id, tsw_version) VALUES (?, ?, ?)', [name, country_id, tsw_version]);
        // Get ID immediately after insert, before saveDatabase
        const result = db.exec('SELECT last_insert_rowid() as id');
        console.log('routeDb.create last_insert_rowid result:', JSON.stringify(result));
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        console.log('routeDb.create returning lastId:', lastId);
        saveDatabase();
        return { lastInsertRowid: lastId };
    },
    update: (id, name, country_id, tsw_version) => {
        db.run('UPDATE routes SET name = ?, country_id = ?, tsw_version = ? WHERE id = ?', [name, country_id, tsw_version, id]);
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
    },
    // Train Class methods
    getTrainClasses: (routeId) => {
        const stmt = db.prepare(`
            SELECT tc.* FROM train_classes tc
            INNER JOIN route_train_classes rtc ON tc.id = rtc.class_id
            WHERE rtc.route_id = ?
            ORDER BY tc.name
        `);
        stmt.bind([routeId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    addTrainClass: (routeId, classId) => {
        db.run('INSERT OR IGNORE INTO route_train_classes (route_id, class_id) VALUES (?, ?)', [routeId, classId]);
        saveDatabase();
    },
    removeTrainClass: (routeId, classId) => {
        db.run('DELETE FROM route_train_classes WHERE route_id = ? AND class_id = ?', [routeId, classId]);
        saveDatabase();
    },
    // Get trains for a specific class on a route
    getTrainsForClass: (routeId, classId) => {
        // Get all trains in the class, not just ones linked to route_trains
        const stmt = db.prepare(`
            SELECT t.* FROM trains t
            WHERE t.class_id = ?
            ORDER BY t.name
        `);
        stmt.bind([classId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    }
};

// Train Class CRUD operations
const trainClassDb = {
    getAll: () => {
        const stmt = db.prepare('SELECT * FROM train_classes ORDER BY name');
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    getById: (id) => {
        const stmt = db.prepare('SELECT * FROM train_classes WHERE id = ?');
        stmt.bind([id]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    getByName: (name) => {
        const stmt = db.prepare('SELECT * FROM train_classes WHERE name = ?');
        stmt.bind([name]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    create: (name) => {
        db.run('INSERT INTO train_classes (name) VALUES (?)', [name]);
        const result = db.exec('SELECT last_insert_rowid() as id');
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        saveDatabase();
        return { lastInsertRowid: lastId };
    },
    update: (id, name) => {
        db.run('UPDATE train_classes SET name = ? WHERE id = ?', [name, id]);
        saveDatabase();
    },
    delete: (id) => {
        db.run('DELETE FROM train_classes WHERE id = ?', [id]);
        saveDatabase();
    },
    getTrains: (classId) => {
        const stmt = db.prepare('SELECT * FROM trains WHERE class_id = ? ORDER BY name');
        stmt.bind([classId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    getRoutes: (classId) => {
        const stmt = db.prepare(`
            SELECT r.* FROM routes r
            INNER JOIN route_train_classes rtc ON r.id = rtc.route_id
            WHERE rtc.class_id = ?
            ORDER BY r.name
        `);
        stmt.bind([classId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
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
    getAllWithClass: () => {
        const stmt = db.prepare(`
            SELECT t.*, tc.name as class_name
            FROM trains t
            LEFT JOIN train_classes tc ON t.class_id = tc.id
            ORDER BY t.name
        `);
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
    getByIdWithClass: (id) => {
        const stmt = db.prepare(`
            SELECT t.*, tc.name as class_name
            FROM trains t
            LEFT JOIN train_classes tc ON t.class_id = tc.id
            WHERE t.id = ?
        `);
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
    getByClassId: (classId) => {
        const stmt = db.prepare('SELECT * FROM trains WHERE class_id = ? ORDER BY name');
        stmt.bind([classId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    create: (name, classId = null) => {
        db.run('INSERT INTO trains (name, class_id) VALUES (?, ?)', [name, classId]);
        const result = db.exec('SELECT last_insert_rowid() as id');
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        saveDatabase();
        return { lastInsertRowid: lastId };
    },
    update: (id, name, classId = null) => {
        db.run('UPDATE trains SET name = ?, class_id = ? WHERE id = ?', [name, classId, id]);
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
    },
    setClass: (trainId, classId) => {
        db.run('UPDATE trains SET class_id = ? WHERE id = ?', [classId, trainId]);
        saveDatabase();
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
    getByIdWithTrains: (id) => {
        const timetable = timetableDb.getById(id);
        if (timetable) {
            timetable.trains = timetableDb.getTrains(id);
        }
        return timetable;
    },
    getByServiceName: (serviceName) => {
        const stmt = db.prepare('SELECT * FROM timetables WHERE service_name = ?');
        stmt.bind([serviceName]);
        let result = null;
        if (stmt.step()) {
            result = stmt.getAsObject();
        }
        stmt.free();
        return result;
    },
    // Check if a service name exists (optionally excluding a specific timetable ID)
    serviceNameExists: (serviceName, excludeId = null) => {
        let query = 'SELECT COUNT(*) FROM timetables WHERE service_name = ?';
        const params = [serviceName];
        if (excludeId !== null) {
            query += ' AND id != ?';
            params.push(excludeId);
        }
        const result = db.exec(query, params);
        return result.length > 0 && result[0].values[0][0] > 0;
    },
    create: (serviceName, routeId = null, trainId = null, trainIds = null) => {
        db.run('INSERT INTO timetables (service_name, route_id, train_id) VALUES (?, ?, ?)', [serviceName, routeId, trainId]);
        const result = db.exec('SELECT last_insert_rowid() as id');
        console.log('last_insert_rowid result:', JSON.stringify(result));
        const lastId = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
        console.log('Parsed lastId:', lastId);

        // Insert train_ids into timetable_trains junction table
        if (trainIds && Array.isArray(trainIds) && trainIds.length > 0) {
            const stmt = db.prepare('INSERT OR IGNORE INTO timetable_trains (timetable_id, train_id) VALUES (?, ?)');
            for (const tid of trainIds) {
                stmt.run([lastId, tid]);
            }
            stmt.free();
        } else if (trainId) {
            // Backward compatibility: also insert single trainId into junction
            db.run('INSERT OR IGNORE INTO timetable_trains (timetable_id, train_id) VALUES (?, ?)', [lastId, trainId]);
        }

        saveDatabase();
        return { lastInsertRowid: lastId };
    },
    update: (id, data) => {
        // Build dynamic update query based on provided fields
        const updates = [];
        const params = [];

        if (data.service_name !== undefined) {
            updates.push('service_name = ?');
            params.push(data.service_name);
        }
        if (data.route_id !== undefined) {
            updates.push('route_id = ?');
            params.push(data.route_id);
        }
        if (data.train_id !== undefined) {
            updates.push('train_id = ?');
            params.push(data.train_id);
        }

        if (updates.length > 0) {
            params.push(id);
            db.run(`UPDATE timetables SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        // Handle train_ids array for junction table
        if (data.train_ids !== undefined && Array.isArray(data.train_ids)) {
            timetableDb.setTrains(id, data.train_ids);
        }

        saveDatabase();
    },
    delete: (id) => {
        db.run('DELETE FROM timetable_trains WHERE timetable_id = ?', [id]);
        db.run('DELETE FROM timetable_entries WHERE timetable_id = ?', [id]);
        db.run('DELETE FROM timetables WHERE id = ?', [id]);
        saveDatabase();
    },
    // Get trains associated with a timetable (includes class info)
    getTrains: (timetableId) => {
        const stmt = db.prepare(`
            SELECT t.*, tc.name as class_name FROM trains t
            INNER JOIN timetable_trains tt ON t.id = tt.train_id
            LEFT JOIN train_classes tc ON t.class_id = tc.id
            WHERE tt.timetable_id = ?
            ORDER BY t.name
        `);
        stmt.bind([timetableId]);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    },
    // Set trains for a timetable (replaces all existing)
    setTrains: (timetableId, trainIds) => {
        db.run('DELETE FROM timetable_trains WHERE timetable_id = ?', [timetableId]);
        if (trainIds && Array.isArray(trainIds) && trainIds.length > 0) {
            const stmt = db.prepare('INSERT OR IGNORE INTO timetable_trains (timetable_id, train_id) VALUES (?, ?)');
            for (const tid of trainIds) {
                stmt.run([timetableId, tid]);
            }
            stmt.free();
        }
        saveDatabase();
    },
    // Add a train to a timetable
    addTrain: (timetableId, trainId) => {
        db.run('INSERT OR IGNORE INTO timetable_trains (timetable_id, train_id) VALUES (?, ?)', [timetableId, trainId]);
        saveDatabase();
    },
    // Remove a train from a timetable
    removeTrain: (timetableId, trainId) => {
        db.run('DELETE FROM timetable_trains WHERE timetable_id = ? AND train_id = ?', [timetableId, trainId]);
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
        // Validate time format (HH:MM:SS)
        validateTimeFormat(entry.time1, 'time1');
        validateTimeFormat(entry.time2, 'time2');

        console.log(`  -> INSERT timetable_entries: timetable_id=${timetableId}, action=${entry.action}, sort_order=${sortOrder}`);
        db.run(
            'INSERT INTO timetable_entries (timetable_id, action, details, location, platform, time1, time2, latitude, longitude, api_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [timetableId, entry.action, entry.details || '', entry.location || '', entry.platform || '', entry.time1 || '', entry.time2 || '', entry.latitude || '', entry.longitude || '', entry.api_name || '', sortOrder]
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
        // Validate time format (HH:MM:SS)
        validateTimeFormat(entry.time1, 'time1');
        validateTimeFormat(entry.time2, 'time2');

        db.run(
            'UPDATE timetable_entries SET action = ?, details = ?, location = ?, platform = ?, time1 = ?, time2 = ?, latitude = ?, longitude = ?, api_name = ? WHERE id = ?',
            [entry.action, entry.details || '', entry.location || '', entry.platform || '', entry.time1 || '', entry.time2 || '', entry.latitude || '', entry.longitude || '', entry.api_name || '', id]
        );
        saveDatabase();
    },
    delete: (id) => {
        db.run('DELETE FROM timetable_entries WHERE id = ?', [id]);
        saveDatabase();
    },
    // Update coordinates and apiName for an entry by matching timetable_id and location
    updateCoordinatesByLocation: (timetableId, location, latitude, longitude, apiName) => {
        db.run(
            'UPDATE timetable_entries SET latitude = ?, longitude = ?, api_name = ? WHERE timetable_id = ? AND location = ?',
            [latitude.toString(), longitude.toString(), apiName || '', timetableId, location]
        );
        saveDatabase();
    },
    // Update coordinates and apiName for an entry by matching timetable_id, sort_order, and action
    // Used for WAIT FOR SERVICE entries that may have empty location
    updateCoordinatesBySortOrderAndAction: (timetableId, sortOrder, action, latitude, longitude, apiName) => {
        db.run(
            'UPDATE timetable_entries SET latitude = ?, longitude = ?, api_name = ? WHERE timetable_id = ? AND sort_order = ? AND action = ?',
            [latitude.toString(), longitude.toString(), apiName || '', timetableId, sortOrder, action]
        );
        saveDatabase();
    },
    // Update coordinates only for an entry by its ID (for SAVE LOC button)
    updateCoordinatesById: (id, latitude, longitude) => {
        db.run(
            'UPDATE timetable_entries SET latitude = ?, longitude = ? WHERE id = ?',
            [latitude.toString(), longitude.toString(), id]
        );
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
        const stmt = db.prepare('SELECT coordinates FROM timetable_coordinates WHERE timetable_id = ?');
        stmt.bind([timetableId]);
        let coordinates = [];
        if (stmt.step()) {
            const row = stmt.getAsObject();
            try {
                coordinates = JSON.parse(row.coordinates);
            } catch (e) {
                console.error('Failed to parse coordinates JSON:', e);
            }
        }
        stmt.free();
        return coordinates;
    },
    getCount: (timetableId) => {
        const coords = timetableCoordinateDb.getByTimetableId(timetableId);
        return coords.length;
    },
    deleteByTimetableId: (timetableId) => {
        db.run('DELETE FROM timetable_coordinates WHERE timetable_id = ?', [timetableId]);
        saveDatabase();
    },
    insert: (timetableId, coordinates) => {
        // Delete existing coordinates first
        db.run('DELETE FROM timetable_coordinates WHERE timetable_id = ?', [timetableId]);

        // Insert coordinates as JSON string
        const coordsJson = JSON.stringify(coordinates);
        db.run('INSERT INTO timetable_coordinates (timetable_id, coordinates) VALUES (?, ?)', [timetableId, coordsJson]);
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
        const stmt = db.prepare('INSERT INTO timetable_markers (timetable_id, station_name, marker_type, latitude, longitude, platform_length) VALUES (?, ?, ?, ?, ?, ?)');
        for (const marker of markers) {
            stmt.run([
                timetableId,
                marker.stationName || marker.station_name,
                marker.markerType || marker.marker_type || 'Station',
                marker.latitude || null,
                marker.longitude || null,
                marker.platformLength || marker.platform_length || null
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

        // Get trains associated with this timetable
        const trains = timetableDb.getTrains(timetableId);

        // Build the data object
        // - coordinates: GPS path for the route polyline
        // - markers: raw discovered markers from game API (kept for future use)
        // - timetable: the actual stations in stopping order (used for map display)
        return {
            routeName: timetable.service_name,
            timetableId: timetable.id,
            routeId: timetable.route_id,
            trainId: timetable.train_id,  // kept for backward compatibility
            trains: trains.map(t => ({ id: t.id, name: t.name })),  // new: array of trains
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
                   tc.coordinates as coordinates_json,
                   (SELECT COUNT(*) FROM timetable_markers WHERE timetable_id = t.id) as marker_count
            FROM timetables t
            INNER JOIN timetable_coordinates tc ON tc.timetable_id = t.id
            ORDER BY t.service_name
        `);
        const results = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            // Parse JSON to get coordinate count
            try {
                const coords = JSON.parse(row.coordinates_json || '[]');
                row.coordinate_count = coords.length;
            } catch (e) {
                row.coordinate_count = 0;
            }
            delete row.coordinates_json;
            results.push(row);
        }
        stmt.free();
        return results;
    },

    // Get all timetables with coordinate counts
    getAllWithCounts: () => {
        const stmt = db.prepare(`
            SELECT t.*,
                   tc.coordinates as coordinates_json,
                   (SELECT COUNT(*) FROM timetable_markers WHERE timetable_id = t.id) as marker_count
            FROM timetables t
            LEFT JOIN timetable_coordinates tc ON tc.timetable_id = t.id
            ORDER BY t.id DESC
        `);
        const results = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            // Parse JSON to get coordinate count
            try {
                const coords = JSON.parse(row.coordinates_json || '[]');
                row.coordinate_count = coords.length;
            } catch (e) {
                row.coordinate_count = 0;
            }
            delete row.coordinates_json;
            results.push(row);
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
    trainClassDb,
    timetableDb,
    entryDb,
    weatherPresetDb,
    timetableCoordinateDb,
    timetableMarkerDb,
    timetableDataDb,
    stationMappingDb
};
