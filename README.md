# TSW HUD Project

A Train Sim World dashboard HUD system with SQLite database support.

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

The server will start on http://127.0.0.1:3000

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


# How to Run TSW HUD Project

## How It Works

| Method | Command | Uses |
|--------|---------|------|
| Developer | `node server.js` or `npm start` | System Node + root `node_modules/` |
| Portable user | Double-click `TSW_HUD_Start.bat` | `runtime/node.exe` + `runtime/node_modules/` |

**Both methods run the same code files!**

## When to Rebuild

| Action | Need to rebuild runtime? |
|--------|-------------------------|
| Edit `server.js`, `ocr.js`, etc. | ❌ No |
| Edit HTML/CSS in `public/` | ❌ No |
| Add new npm package (`npm install xyz`) | ✅ Yes |
| Update packages (`npm update`) | ✅ Yes |

## Commands

```powershell
# Build the runtime (first time, or after npm changes)
npm run build:runtime

# Run with system Node (development)
npm start

# Run with embedded Node (portable)
.\TSW_HUD_Start.bat
```

To change anthropic model
ctrl + shift + p
Preferences: Open User Settings (JSON)


1. Add a stop watcher for live recordings that stops once all the stops have been recorded.
2. I might want a clock on the front end that show how long the stop is taking. at least for debugging
3. Need to account for how we create timetable entries when we have things like "Wait" or "Stop at location" when they don't have two times, time 1 arrival, time 2 departure. and "Via", "Via" might have a flag on it, which might solve the "Wait" issue too
4. Frieght, this might require a completely different approach.

5. consolidate code for creating timetabels with image uplaods on this page
http://localhost:3000/timetables
http://localhost:3000/trains/91?from_route=81

6. We might need a default "Location" of "Start" for creating timetables
http://localhost:3000/timetables
http://localhost:3000/trains/91?from_route=81



Now lets move this logic into the back end.
When the train is in automatic it should record the coordinates for each stop in the file
"C:\Users\hcfai\Desktop\git\tsw_hud_project\recording_data\raw_data_timetable_24_2026-02-19_03-38-12.json"
In the timetable section
We need to account for things that have via because they are not stops.
So if we have 5 items in the timetable but one of them is a via we need to skip that one and record in the other sections.
Once we have recorded all the stops and the time is past the last arrival time, stop the automatic recording.



    {
      "index": 1,
      "location": "Power Changeover Location",
      "arrival": "",
      "departure": "",
      "platform": "",
      "apiName": "Power Changeover Location",
      "isPassThrough": true
    },