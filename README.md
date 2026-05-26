# HydroDesign Pro

A browser-based hydronic heating system designer — drag, connect, price, and order HVAC parts without leaving your browser.

---

## Features

- **Visual Canvas** — Drag components onto an SVG canvas, snap to a 20 px grid, route orthogonal pipes, zoom in/out, and fit the view
- **90+ Part Local Catalog** — 13 categories covering heat sources, pumps, valves, tanks, separators, gauges, manifolds, fittings, and tubing (see [Catalog](#catalog-categories))
- **SupplyHouse.com Live Search** — Sign in once; search any HVAC part, add it to your canvas design, or push it straight to your SupplyHouse cart
- **Pipe Labels** — Auto-labeled pipe runs show material (Cu / PEX) and size; toggle visibility on or off
- **Text Annotations** — Place and drag free-form text callouts anywhere on the canvas with the Label tool
- **Live Bill of Materials** — Aggregated by part number, subtotal + 8 % tax, one-click CSV export and print/PDF
- **Project Management** — Save and load full canvas state to a local SQLite database
- **Inventory Tracker** — Track parts on hand and import the current BOM into your inventory with one click

---

## Quick Start

```bash
git clone https://github.com/gmsb2/hydrodesign-pro
cd hydrodesign-pro
npm install
node server.js   # → http://localhost:3001
```

Open **http://localhost:3001** in your browser. No build step required.

**Prerequisites:** Node.js 18+ (uses `better-sqlite3`, which requires a native build; standard `npm install` handles this automatically).

---

## Usage

### Visual Canvas

The center panel is an SVG canvas with a 20 px snap grid.

| Action | How |
|---|---|
| Add a part | Drag from the left catalog panel onto the canvas |
| Move a part | Select tool (S), then drag |
| Connect parts | Connect tool (C), click source component, click destination |
| Delete selected | D or Delete key |
| Zoom | Scroll wheel |
| Fit all to view | Click **Fit View** in the toolbar |

Pipes are drawn as orthogonal (right-angle) routes. Each pipe inherits the material you set (copper or PEX) and size, which appear as a label along the run.

### Pipe Labels

Labels on pipe runs show the material abbreviation (Cu / PEX) and nominal size. Toggle label visibility with the **Labels** button in the toolbar. Labels update automatically when you change a pipe's properties.

### Text Annotations

Press **L** or select the Label tool to place a free-form text callout on the canvas. Click to set the anchor point, type the annotation, then press Enter to confirm. Drag the callout to reposition it at any time.

### Catalog Categories

The left panel contains 90+ parts organized into 13 categories:

| Category | Example Parts |
|---|---|
| Heat Sources | Weil-McLain and Navien boilers |
| Circulator Pumps | Taco and Grundfos circulators |
| Ball Valves | Full-port brass ball valves |
| Check Valves | Swing and spring check valves |
| Control Valves | Zone valves, mixing valves |
| Expansion Tanks | Extrol and bladder tanks |
| Air Separators | Microair, Spirovent |
| Gauges | Pressure and temp/pressure gauges |
| Manifolds | Radiant distribution manifolds |
| Copper Fittings | Elbows, tees, couplings |
| Copper Tubing | Type L and Type K, priced per LF |
| PEX Tubing | PEX-A and PEX-B, priced per LF |
| PEX Fittings | Crimp and expansion fittings |
| Heat Emitters | Baseboard and panel radiators |

### SupplyHouse.com Live Search

1. Click **Sign In** in the left panel and enter your SupplyHouse.com credentials.
2. Type any part name, model number, or brand in the search box.
3. Results appear in the left panel:
   - Click **+ Design** to add the part to the canvas.
   - Click the cart icon to add the part directly to your SupplyHouse.com online cart.
4. Sign out with the **Logout** button when finished.

The proxy automatically handles all three SupplyHouse search response types:

- **Product list** — standard results returned directly.
- **productRedirect** — exact model match; the proxy fetches the single product and returns it.
- **kwRedirect** — brand or category page; the proxy re-searches using the redirect slug and returns the resolved results.

### Bill of Materials

The right panel updates in real time as you add, move, or delete components. Parts are aggregated by part number so duplicates are combined into a single line with a quantity.

The panel shows:
- Part number, description, unit price, quantity, and line total
- **Subtotal** and **Total with 8 % tax**
- **Export CSV** button — downloads the current BOM as a `.csv` file
- **Print / PDF** button — opens a print-ready view of the BOM

### Project Management

- **Save (💾)** — serializes the full canvas state (components, pipes, annotations, properties) to JSON and writes it to the local SQLite database.
- **Projects (📂)** — opens a list of saved projects; click any project to load it onto the canvas.

Projects are stored in `hydrodesign.db` on your local machine and are never sent anywhere.

### Inventory

Click the **Inventory** tab in the left panel to manage on-hand stock:

- Each row shows a part and its `qty_on_hand`.
- Edit quantity inline and save.
- Click **+ From BOM** to import all parts from the current design into the inventory list, creating new rows for any part not yet tracked.

---

## Keyboard Shortcuts

| Key | Tool / Action |
|---|---|
| S | Select tool |
| C | Connect tool (draw pipes) |
| D | Delete tool |
| L | Label tool (text annotation) |
| Delete | Remove selected component or pipe |
| Esc | Cancel current action |

---

## API Reference

All endpoints are served by the local Express server on **http://localhost:3001**.

### SupplyHouse.com Proxy

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/search?q=&page=` | Search SupplyHouse.com; handles all redirect types |
| `POST` | `/api/login` | Sign in `{ email, password }` |
| `GET` | `/api/status` | Returns current session status |
| `POST` | `/api/logout` | Clears the session cookie |
| `POST` | `/api/cart/add` | Add item to SupplyHouse cart `{ productId, qty }` |
| `GET` | `/api/cart` | Retrieve current cart contents |

### Database (SQLite)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/db/projects` | List all saved projects |
| `POST` | `/api/db/projects` | Create a new project |
| `GET` | `/api/db/projects/:id` | Load a single project |
| `PUT` | `/api/db/projects/:id` | Update (overwrite) a project |
| `DELETE` | `/api/db/projects/:id` | Delete a project |
| `GET` | `/api/db/parts-history` | List parts previously used in designs |
| `GET` | `/api/db/inventory` | List all inventory records |
| `POST` | `/api/db/inventory` | Add a new inventory record |
| `PUT` | `/api/db/inventory/:id` | Update an inventory record |
| `DELETE` | `/api/db/inventory/:id` | Remove an inventory record |

---

## Project Structure

```
hydrodesign-pro/
├── index.html        # Complete frontend — canvas, catalog, BOM (single file, no build step)
├── server.js         # Express API server + SupplyHouse.com session proxy
├── package.json
├── .gitignore
└── hydrodesign.db    # SQLite database (local only, gitignored)
```

---

## Notes

- **Local only** — `hydrodesign.db` is gitignored and never leaves your machine. No account or cloud sync is required.
- **SupplyHouse.com credentials** — Your login session is maintained via a server-side cookie jar (`tough-cookie`). Credentials are only sent to SupplyHouse.com; they are not stored on disk.
- **Tubing priced per linear foot** — Copper Type L/K and PEX-A/B entries in the catalog carry a per-LF unit price. The BOM multiplies this by the total length of all pipe runs of that type.
- **No framework** — The frontend is plain HTML, CSS, and JavaScript with no bundler, no React, no build step. Open `index.html` via the Express server and everything loads in one request.
- **Port** — The server listens on port **3001** by default. To change it, set the `PORT` environment variable before starting: `PORT=4000 node server.js`.
