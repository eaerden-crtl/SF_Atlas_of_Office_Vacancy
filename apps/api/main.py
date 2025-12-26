from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


DATA_FILE = Path(__file__).resolve().parents[2] / "data" / "SF_Final.geojson"
BRIDGE_URL = "http://127.0.0.1:8010/generate"

app = FastAPI(title="SF Office Vacancy API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


def _normalize(text: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", " ", text.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def format_address(properties: Dict[str, Any]) -> str:
    """Return a human-readable address string."""
    number = str(properties.get("number") or "").strip()
    street = str(properties.get("street") or "").strip()
    postcode = str(properties.get("postcode") or "").strip()
    return " ".join(part for part in [number, street, postcode] if part)


def _load_data() -> Dict[str, Any]:
    with DATA_FILE.open() as f:
        return json.load(f)


def _build_search_index(features: List[Dict[str, Any]]):
    index = []
    for feature in features:
        props = feature.get("properties", {})
        address = format_address(props)
        normalized_address = _normalize(address)
        index.append({
            "feature": feature,
            "address": address,
            "normalized_address": normalized_address,
        })
    return index


DATA_CACHE: Dict[str, Any] = {}


@app.on_event("startup")
async def startup_event():
    data = _load_data()
    features = data.get("features", [])
    DATA_CACHE["data"] = data
    DATA_CACHE["features"] = features
    DATA_CACHE["search_index"] = _build_search_index(features)


def _score_match(query: str, candidate: str) -> float:
    return SequenceMatcher(None, query, candidate).ratio()


def _extract_match_payload(entry: Dict[str, Any], score: float) -> Dict[str, Any]:
    feature = entry["feature"]
    props = feature.get("properties", {})
    return {
        "id": props.get("id"),
        "score": score,
        "address": entry["address"],
        "number": props.get("number"),
        "street": props.get("street"),
        "postcode": props.get("postcode"),
        "height_m": props.get("height"),
        "vacancy_pct": props.get("Percentage_vacant"),
    }


@app.get("/health")
async def health_check():
    features = DATA_CACHE.get("features", [])
    return {"ok": True, "features": len(features)}


@app.get("/search")
async def search(query: str = Query(..., min_length=1)):
    normalized_query = _normalize(query)
    if not normalized_query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    search_index = DATA_CACHE.get("search_index", [])
    scored = []
    for entry in search_index:
        score = _score_match(normalized_query, entry["normalized_address"])
        scored.append((score, entry))

    scored.sort(key=lambda item: item[0], reverse=True)
    top_matches = [
        _extract_match_payload(entry, score) for score, entry in scored[:5]
    ]
    return top_matches


def _find_feature_by_id(feature_id: str) -> Optional[Dict[str, Any]]:
    for feature in DATA_CACHE.get("features", []):
        props = feature.get("properties", {})
        if props.get("id") == feature_id:
            return feature
    return None


def _build_building_response(feature: Optional[Dict[str, Any]], feature_id: str):
    if feature is None:
        return {"found": False, "id": feature_id}

    props = feature.get("properties", {})
    return {
        "found": True,
        "id": props.get("id"),
        "address": format_address(props),
        "height_m": props.get("height"),
        "vacancy_pct": props.get("Percentage_vacant"),
        "properties": props,
        "geometry": feature.get("geometry"),
    }


@app.get("/building")
async def get_building(id: str = Query(...)):
    feature = _find_feature_by_id(id)
    return _build_building_response(feature, id)


@app.get("/building_by_address")
async def building_by_address(query: str = Query(..., min_length=1)):
    normalized_query = _normalize(query)
    if not normalized_query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    search_index = DATA_CACHE.get("search_index", [])
    best_entry = None
    best_score = -1.0
    for entry in search_index:
        score = _score_match(normalized_query, entry["normalized_address"])
        if score > best_score:
            best_score = score
            best_entry = entry

    feature = best_entry["feature"] if best_entry else None
    return _build_building_response(feature, query)


@app.post("/generate_model", response_model=GenerateModelResponse)
async def generate_model(payload: GenerateModelRequest):
    request_body = payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
    encoded = json.dumps(request_body).encode("utf-8")
    request = urllib.request.Request(
        BRIDGE_URL,
        data=encoded,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            response_body = response.read().decode("utf-8")
            status_code = response.status
    except urllib.error.URLError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Bridge service unavailable at {BRIDGE_URL}: {exc}",
        ) from exc

    if status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Bridge error (status {status_code}).",
        )

    try:
        payload = json.loads(response_body)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail="Bridge response was not valid JSON.",
        ) from exc

    return payload
