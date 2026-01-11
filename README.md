# TSW HUD Project

A compilable Train Sim World dashboard HUD system with SQLite database support.

## Features

- SQLite database for persistent storage
- RESTful API for routes management
- Compilable to Windows .exe
- Web-based interface

## Setup

```bash
npm install
npm start
```

The server will start on http://localhost:3000

## Build for Windows

```bash
npm run build
```

This creates `dist/tsw-hud.exe` - a standalone executable that includes Node.js runtime.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/routes | Get all routes |
| POST | /api/routes | Create a route |
| GET | /api/routes/:id | Get a route by ID |
| PUT | /api/routes/:id | Update a route |
| DELETE | /api/routes/:id | Delete a route |

## Database

Uses SQLite with `better-sqlite3`. The database file `tsw_hud.db` is created automatically on first run.

## Dependencies

- `better-sqlite3` - Fast SQLite3 bindings (synchronous API)
- `axios` - HTTP client for API calls
- `csv-writer` - CSV file writing utility


# If you know the port (3000)
npx kill-port 3000

# Or find and kill the node process
taskkill /F /IM node.exe