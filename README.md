# SF Atlas of Office Vacancy API

This repository includes a small FastAPI service that serves data from `data/SF_Final.geojson` and exposes search and lookup endpoints for building information.

## Endpoints
- `GET /health` — basic health status with feature count.
- `GET /search?query=` — top five normalized address matches with scores.
- `GET /building?id=` — lookup by exact `properties.id` value.
- `GET /building_by_address?query=` — best single address match (same shape as `/building`).

## Running locally (Windows)
1. Install Python 3.11 or newer.
2. From the repository root, create and activate a virtual environment:
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\activate
   ```
3. Install dependencies:
   ```powershell
   pip install -r requirements.txt
   ```
4. Start the FastAPI server:
   ```powershell
   uvicorn apps.api.main:app --reload --host 0.0.0.0 --port 8000
   ```

Once running, the API will read `data/SF_Final.geojson` on startup and respond at `http://127.0.0.1:8000`.
