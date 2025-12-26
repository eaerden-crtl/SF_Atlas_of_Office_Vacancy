# Grasshopper Bridge (MVP)

This service bridges the web app to a local Rhino/Grasshopper workflow.

## What it does now

- Accepts a generation payload from `apps/api`.
- Writes the payload to `apps/bridge/out/request_<id>.json`.
- Returns a placeholder GLB URL from `apps/bridge/models/`.

## Future Grasshopper integration

A Grasshopper definition (or Rhino script) should:

1. Watch the `apps/bridge/out/` folder for new `request_*.json` files.
2. Parse `footprint_lonlat`, `height_m`, `stories`, and `vacancy_pct`.
3. Generate a detailed model.
4. Export a `.glb` named `<building_id>.glb` into `apps/bridge/models/`.

The bridge already serves static GLB files at:

```
http://127.0.0.1:8010/models/<building_id>.glb
```

## Run locally

```
uvicorn main:app --reload --port 8010
```
