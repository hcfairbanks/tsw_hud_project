# Claude Code Instructions

## File Paths
Always use relative paths from the project root when reading or editing files.

Examples:
- `views/index.html`
- `views/routes/index.html`
- `views/extract.html`
- `routes/index.js`
- `controllers/routeController.js`
- `controllers/trainController.js`
- `controllers/timetableController.js`
- `controllers/entryController.js`
- `controllers/ocrController.js`
- `db/index.js`
- `utils/http.js`
- `utils/network.js`
- `server.js`
- `build.js`
- `package.json`

Never use absolute paths like `c:\Users\...\tsw_hud_project\...`

## Project Structure
- `views/` - HTML frontend files
- `routes/` - URL routing logic
- `controllers/` - Business logic for API endpoints
- `db/` - Database operations (sql.js/SQLite)
- `utils/` - Utility functions (HTTP helpers, network)

## Tech Stack
- Node.js HTTP server (no Express)
- sql.js (SQLite in JavaScript)
- Tesseract.js for OCR
- Frontend: vanilla HTML/CSS/JavaScript
