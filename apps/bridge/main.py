from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
OUT_DIR = BASE_DIR / "out"

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]


class GenerateModelRequest(BaseModel):
    building_id: str
    footprint_lonlat: List[List[float]]
    height_m: float
    stories: Optional[int] = None
    vacancy_pct: Optional[float] = None
    timestamp: str


class GenerateModelResponse(BaseModel):
    ok: bool
    building_id: str
    model_url: str
    generated_at: str
    notes: str


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", value.strip())
    return cleaned or "unknown"


def _write_placeholder_glb(path: Path) -> None:
    # Minimal GLB containing a single triangle; useful for plumbing tests.
    import struct

    positions = [
        0.0,
        1.0,
        0.0,
        -1.0,
        -1.0,
        0.0,
        1.0,
        -1.0,
        0.0,
    ]
    bin_chunk = struct.pack("<9f", *positions)

    json_dict = {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "buffers": [{"byteLength": len(bin_chunk)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(bin_chunk)}
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 3,
                "type": "VEC3",
                "min": [-1.0, -1.0, 0.0],
                "max": [1.0, 1.0, 0.0],
            }
        ],
    }

    json_bytes = json.dumps(json_dict, separators=(",", ":")).encode("utf-8")
    json_padding = (4 - (len(json_bytes) % 4)) % 4
    json_bytes += b" " * json_padding

    bin_padding = (4 - (len(bin_chunk) % 4)) % 4
    bin_bytes = bin_chunk + (b"\x00" * bin_padding)

    total_length = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)

    with path.open("wb") as handle:
        handle.write(b"glTF")
        handle.write(struct.pack("<I", 2))
        handle.write(struct.pack("<I", total_length))
        handle.write(struct.pack("<I", len(json_bytes)))
        handle.write(b"JSON")
        handle.write(json_bytes)
        handle.write(struct.pack("<I", len(bin_bytes)))
        handle.write(b"BIN\x00")
        handle.write(bin_bytes)


app = FastAPI(title="SF Office Vacancy Bridge")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/health")
async def health_check() -> dict:
    return {"ok": True}


@app.post("/generate", response_model=GenerateModelResponse)
async def generate_model(payload: GenerateModelRequest) -> GenerateModelResponse:
    safe_id = _safe_id(payload.building_id)
    request_path = OUT_DIR / f"request_{safe_id}.json"
    if hasattr(payload, "model_dump_json"):
        request_json = payload.model_dump_json(indent=2)
    else:
        request_json = payload.json(indent=2)
    request_path.write_text(request_json, encoding="utf-8")

    model_filename = f"{safe_id}.glb"
    model_path = MODELS_DIR / model_filename
    if not model_path.exists():
        _write_placeholder_glb(model_path)

    return GenerateModelResponse(
        ok=True,
        building_id=payload.building_id,
        model_url=f"/models/{model_filename}",
        generated_at=_utc_now(),
        notes="Placeholder model. Replace with Grasshopper-generated GLB.",
    )


app.mount("/models", StaticFiles(directory=MODELS_DIR), name="models")
