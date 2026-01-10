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
