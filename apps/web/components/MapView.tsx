'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import Map, { type MapRef } from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import area from '@turf/area';
import bbox from '@turf/bbox';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fetchBuildingByIdWithMeta, searchBuildings, type SearchResult } from '../src/lib/api';
import { useDebouncedValue } from '../src/lib/search';
import ModelViewer from './ModelViewer';

interface BuildingProperties {
  id?: string;
  number?: string;
  street?: string;
  postcode?: string;
  height?: number;
  Percentage_vacant?: number;
  percentage_vacant?: number;
  names?: {
    primary?: string;
    common?: string;
  };
  class?: string;
  subtype?: string;
  stories?: number;
  storeys?: number;
  levels?: number;
  floors?: number;
  num_floors?: number;
  floor_count?: number;
  building_levels?: number;
  [key: string]: unknown;
}

interface GenerateModelRequest {
  building_id: string;
  footprint_lonlat: number[][];
  height_m: number;
  stories: number | null;
  vacancy_pct: number | null;
  timestamp: string;
}

interface GenerateModelResponse {
  ok: boolean;
  building_id: string;
  model_url: string;
  generated_at: string;
  notes?: string;
}

const INITIAL_VIEW_STATE = {
  longitude: -122.4194,
  latitude: 37.7749,
  zoom: 12.8,
  pitch: 60,
  bearing: -20
};

const BASE_COLOR = [217, 242, 255, 210] as const;
const BASE_HIGHLIGHT = [160, 200, 230, 240] as const;
const BASE_MATERIAL = { ambient: 0.3, diffuse: 0.6, shininess: 8, specularColor: [255, 255, 255] } as const;
const VACANCY_COLOR = [35, 60, 120, 220] as const;
const VACANCY_HIGHLIGHT = [55, 90, 160, 240] as const;

const NORMALIZED_BOUNDS = {
  minLng: -122.4319774,
  maxLng: -122.3804987,
  minLat: 37.770873,
  maxLat: 37.8114532
};

function toCssRgba(color: readonly number[]): string {
  const [r, g, b, a] = color;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hashStringToSeed(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0; // convert to 32bit int
  }
  return Math.abs(hash) + 1;
}

function seededRandom(seed: number): number {
  // mulberry32
  let t = seed + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function addBaseToGeometry(geometry: Geometry, base: number): Geometry {
  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((ring) => addBaseToRing(ring, base))
    };
  }

  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((poly) => poly.map((ring) => addBaseToRing(ring, base)))
    };
  }

  return geometry;
}

function addBaseToRing(ring: Position[], base: number): Position[] {
  return ring.map(([lng, lat]) => [lng, lat, base]);
}

function getFootprintLonLat(feature: BuildingFeature | null): number[][] {
  if (!feature) return [];
  const { geometry } = feature;
  let ring: Position[] | undefined;

  if (geometry.type === 'Polygon') {
    ring = geometry.coordinates[0];
  } else if (geometry.type === 'MultiPolygon') {
    ring = geometry.coordinates[0]?.[0];
  }

  if (!ring) return [];
  return ring.map(([lng, lat]) => [lng, lat]);
}

function isNormalizedCoordinate(position: Position): boolean {
  const [lng, lat] = position;
  return Math.abs(lng) <= 1.5 && Math.abs(lat) <= 1.5;
}

function normalizePosition(position: Position): Position {
  const [lng, lat, elevation] = position;
  if (!isNormalizedCoordinate(position)) return position;

  const mappedLng = NORMALIZED_BOUNDS.minLng + (NORMALIZED_BOUNDS.maxLng - NORMALIZED_BOUNDS.minLng) * lng;
  const mappedLat = NORMALIZED_BOUNDS.minLat + (NORMALIZED_BOUNDS.maxLat - NORMALIZED_BOUNDS.minLat) * lat;

  return elevation !== undefined ? [mappedLng, mappedLat, elevation] : [mappedLng, mappedLat];
}

function convertGeometry(geometry: Geometry): Geometry {
  const convertRing = (ring: Position[]): Position[] => ring.map((position) => normalizePosition(position));

  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((ring) => convertRing(ring))
    };
  }

  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((poly) => poly.map((ring) => convertRing(ring)))
    };
  }

  return geometry;
}

function getBuildingName(props?: BuildingProperties): string | null {
  if (!props || !props.names) return null;

  const primary = typeof props.names.primary === 'string' ? props.names.primary.trim() : '';
  if (primary) return primary;

  const common = typeof props.names.common === 'string' ? props.names.common.trim() : '';
  return common || null;
}

function getBuildingUse(props?: BuildingProperties): string | null {
  if (!props) return null;

  const primary = typeof props.class === 'string' ? props.class.trim() : '';
  if (primary) return primary;

  const fallback = typeof props.subtype === 'string' ? props.subtype.trim() : '';
  return fallback || null;
}

function formatAddress(props?: BuildingProperties): string | null {
  if (!props) return null;

  const parts = [props.number, props.street, props.postcode]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean);

  return parts.length ? parts.join(' ') : null;
}

function formatHeight(props?: BuildingProperties): string | null {
  if (!props) return null;

  const height = Number(props.height);
  if (!Number.isFinite(height)) return null;

  return `${height} m`;
}

function formatArea(value?: number | null): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;

  const formatted = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
  return `${formatted} m²`;
}

function formatVacancyValue(value?: number | null): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return `${Math.round(value * 100)}%`;
}

function getStories(props?: BuildingProperties): number | null {
  if (!props) return null;

  const keys: (keyof BuildingProperties)[] = [
    'stories',
    'storeys',
    'levels',
    'floors',
    'num_floors',
    'floor_count',
    'building_levels'
  ];

  for (const key of keys) {
    const raw = props[key];
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }

  return null;
}

function getFootprintAreaM2(feature: Feature<Geometry> | null | undefined): number | null {
  if (!feature) return null;

  try {
    const computed = area(feature as Feature<Geometry>);
    if (!Number.isFinite(computed) || computed <= 0) return null;
    return computed;
  } catch (err) {
    console.error('Failed to compute area', err);
    return null;
  }
}

function getFloors(height?: number): number | null {
  if (!Number.isFinite(height) || !height || height <= 0) return null;
  const floors = Math.max(Math.round(height / 3.4), 1);
  return floors;
}

function getTotalAreaM2(footprintArea?: number | null, floors?: number | null): number | null {
  if (!Number.isFinite(footprintArea || 0) || footprintArea === null || footprintArea === undefined) return null;
  if (!Number.isFinite(floors || 0) || floors === null || floors === undefined) return null;
  return footprintArea * floors;
}

function hasVacancyData(props?: BuildingProperties): boolean {
  if (!props) return false;
  const raw = props.Percentage_vacant ?? props.percentage_vacant;
  const value = Number(raw);
  return Number.isFinite(value);
}

function getActiveVacancy(
  props: BuildingProperties | undefined,
  submittedMap: Record<string, number | undefined>,
  id: string | undefined,
  totalArea?: number | null
): number | null {
  const raw = props?.Percentage_vacant ?? props?.percentage_vacant;
  const vacancyFromData = Number(raw);
  if (Number.isFinite(vacancyFromData)) {
    return clamp(vacancyFromData, 0, 1);
  }

  if (id && Object.prototype.hasOwnProperty.call(submittedMap, id)) {
    const submittedArea = submittedMap[id];
    if (submittedArea === undefined) return null;
    if (!totalArea || !Number.isFinite(totalArea) || totalArea <= 0) return null;
    if (submittedArea <= 0) return 0;

    const derived = submittedArea / totalArea;
    return clamp(derived, 0, 1);
  }

  return null;
}

type BuildingFeature = Feature<Geometry, BuildingProperties & { vacancyHeight?: number; baseOffset?: number }>;

export default function MapView() {
  const [collection, setCollection] = useState<FeatureCollection<Geometry, BuildingProperties>>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [selectedFeature, setSelectedFeature] = useState<BuildingFeature | null>(null);
  const [selectedOverlayFeature, setSelectedOverlayFeature] = useState<BuildingFeature | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [draftAvailableAreaById, setDraftAvailableAreaById] = useState<Record<string, string>>({});
  const [submittedAvailableAreaById, setSubmittedAvailableAreaById] = useState<Record<string, number | undefined>>({});
  const [reportOpenById, setReportOpenById] = useState<Record<string, boolean>>({});
  const [modelState, setModelState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    url?: string;
    message?: string;
    notes?: string;
  }>({ status: 'idle' });
  const mapRef = useRef<MapRef | null>(null);
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300);

  useEffect(() => {
    let isMounted = true;

    const loadInitialBuildings = async () => {
      const response = await fetch('/data/SF_Final.geojson');
      if (!response.ok) {
        throw new Error(`Failed to load GeoJSON: ${response.status} ${response.statusText}`);
      }
      const json = (await response.json()) as FeatureCollection<Geometry, BuildingProperties>;
      if (!isMounted) return;
      setCollection(json);
    };

    loadInitialBuildings().catch((error) => {
      console.warn('Failed to load GeoJSON', error);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!debouncedSearchQuery.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    let isActive = true;
    setSearchLoading(true);

    searchBuildings(debouncedSearchQuery)
      .then((results) => {
        if (!isActive) return;
        setSearchResults(results.slice(0, 8));
        setSearchLoading(false);
      })
      .catch((error) => {
        console.warn('Search request failed', error);
        if (!isActive) return;
        setSearchResults([]);
        setSearchLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [debouncedSearchQuery]);

  useEffect(() => {
    setModelState({ status: 'idle' });
  }, [selectedId]);

  const zoomToGeometry = useCallback((geometry: Geometry) => {
    if (!mapRef.current) return;

    if (geometry.type === 'Point') {
      const [lng, lat] = geometry.coordinates as [number, number];
      mapRef.current.flyTo({ center: [lng, lat], zoom: 16, duration: 800 });
      return;
    }

    const bounds = bbox({
      type: 'Feature',
      geometry,
      properties: {}
    }) as [number, number, number, number];
    mapRef.current.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]]
      ],
      { padding: 60, duration: 800 }
    );
  }, []);

  const selectBuildingFromApi = useCallback(
    (id: string, localMatch: BuildingFeature | null) => {
      fetchBuildingByIdWithMeta(id)
        .then(({ data, status, url }) => {
          console.log('Building API request', url, status);

          if (!data || !data.found || !data.geometry) return;

          const feature: BuildingFeature = {
            type: 'Feature',
            geometry: convertGeometry(data.geometry as Geometry),
            properties: {
              ...(data.properties ?? {}),
              id: data.id ?? data.properties?.id
            }
          };

          setSelectedFeature(feature);
          if (!localMatch) {
            setSelectedOverlayFeature(feature);
          } else {
            setSelectedOverlayFeature(null);
          }
          zoomToGeometry(feature.geometry);
        })
        .catch((error) => {
          console.warn('Failed to load building details', error);
        });
    },
    [zoomToGeometry]
  );

  const vacancyFeatures = useMemo(() => {
    if (!collection) return [];

    return collection.features
      .map((feature) => {
        const props = feature.properties || {};
        const height = Number(props.height);
        if (!Number.isFinite(height) || height <= 0) {
          return null;
        }

        const footprintArea = getFootprintAreaM2(feature);
        const stories = getStories(props);
        const floors = stories ?? getFloors(height);
        const totalArea = getTotalAreaM2(footprintArea, floors);
        const vacancyShare = getActiveVacancy(props, submittedAvailableAreaById, props.id, totalArea);

        if (!Number.isFinite(vacancyShare) || vacancyShare <= 0) {
          return null;
        }

        const clampedVacancy = clamp(vacancyShare, 0, 1);
        const vacancyHeight = height * clampedVacancy;
        const idSeed = hashStringToSeed(String(props.id ?? ''));
        const offsetRange = Math.max(height - vacancyHeight, 0);
        const baseOffset = offsetRange > 0 ? seededRandom(idSeed) * offsetRange : 0;

        return {
          ...feature,
          geometry: addBaseToGeometry(feature.geometry, baseOffset),
          properties: {
            ...props,
            vacancyHeight,
            baseOffset
          }
        } as BuildingFeature;
      })
      .filter(Boolean) as BuildingFeature[];
  }, [collection, submittedAvailableAreaById]);

  const onFeatureClick = useCallback((info: { object: BuildingFeature | null }) => {
    if (!info.object) return;

    const id = info.object.properties?.id;
    setSelectedId(id);
    setSelectedFeature(info.object);
    setSelectedOverlayFeature(null);

    if (!id) return;

    selectBuildingFromApi(id, info.object);
  }, [selectBuildingFromApi]);

  const handleGenerateModel = useCallback(async () => {
    if (!selectedFeature || !selectedFeature.properties?.id) {
      setModelState({ status: 'error', message: 'Select a building first.' });
      return;
    }

    const props = selectedFeature.properties;
    const payload: GenerateModelRequest = {
      building_id: props.id,
      footprint_lonlat: getFootprintLonLat(selectedFeature),
      height_m: Number(props.height) || 0,
      stories: getStories(props) ?? getFloors(props.height),
      vacancy_pct:
        typeof props.Percentage_vacant === 'number'
          ? props.Percentage_vacant
          : typeof props.percentage_vacant === 'number'
            ? props.percentage_vacant
            : null,
      timestamp: new Date().toISOString()
    };

    setModelState({ status: 'loading' });

    try {
      const response = await fetch('http://127.0.0.1:8000/generate_model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        setModelState({ status: 'error', message: `Bridge error (${response.status}).` });
        return;
      }

      const data = (await response.json()) as GenerateModelResponse;
      if (!data.ok || !data.model_url) {
        setModelState({ status: 'error', message: 'Model generation failed.' });
        return;
      }

      setModelState({
        status: 'ready',
        url: `http://127.0.0.1:8010${data.model_url}`,
        notes: data.notes
      });
    } catch (error) {
      console.warn('Model generation failed', error);
      setModelState({ status: 'error', message: 'Failed to reach the generator.' });
    }
  }, [selectedFeature]);

  const onSearchSelect = useCallback(
    (result: SearchResult) => {
      if (!result) return;

      setSearchOpen(false);
      if (result.address) {
        setSearchQuery(result.address);
      }

      const id = result.id;
      if (!id) return;

      const localMatch =
        collection?.features.find((feature) => feature.properties?.id === id) ?? null;

      setSelectedId(id);
      setSelectedFeature(localMatch as BuildingFeature | null);
      setSelectedOverlayFeature(null);

      if (localMatch) {
        zoomToGeometry(localMatch.geometry);
      }

      selectBuildingFromApi(id, (localMatch as BuildingFeature | null) ?? null);
    },
    [collection, selectBuildingFromApi]
  );

  const formatSearchResult = useCallback((result: SearchResult): string => {
    if (result.address) return result.address;
    const parts = [result.number, result.street, result.postcode]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean);
    return parts.length ? parts.join(' ') : 'Unknown address';
  }, []);

  const baseLayer = useMemo(() => {
    if (!collection) return null;

    return new GeoJsonLayer({
      id: 'base-buildings',
      data: collection,
      pickable: true,
      extruded: true,
      wireframe: false,
      filled: true,
      getElevation: (f: BuildingFeature) => Number(f.properties?.height) || 0,
      getFillColor: (f: BuildingFeature) => (f.properties?.id === selectedId ? BASE_HIGHLIGHT : BASE_COLOR),
      getLineColor: [120, 160, 190],
      material: BASE_MATERIAL,
      onClick: onFeatureClick,
      updateTriggers: {
        getFillColor: [selectedId]
      }
    });
  }, [collection, selectedId, onFeatureClick]);

  const vacancyLayer = useMemo(() => {
    if (!vacancyFeatures.length) return null;

    return new GeoJsonLayer({
      id: 'vacancy-volumes',
      data: vacancyFeatures,
      pickable: true,
      extruded: true,
      wireframe: false,
      filled: true,
      getElevation: (f: BuildingFeature) => Number(f.properties?.vacancyHeight) || 0,
      getFillColor: (f: BuildingFeature) => (f.properties?.id === selectedId ? VACANCY_HIGHLIGHT : VACANCY_COLOR),
      getLineColor: [35, 60, 120],
      onClick: onFeatureClick,
      updateTriggers: {
        getFillColor: [selectedId]
      }
    });
  }, [vacancyFeatures, selectedId, onFeatureClick]);

  const overlayLayer = useMemo(() => {
    if (!selectedOverlayFeature) return null;

    return new GeoJsonLayer({
      id: 'selected-overlay',
      data: selectedOverlayFeature,
      pickable: false,
      extruded: true,
      wireframe: false,
      filled: true,
      getElevation: (f: BuildingFeature) => Number(f.properties?.height) || 0,
      getFillColor: BASE_HIGHLIGHT,
      getLineColor: [120, 160, 190],
      material: BASE_MATERIAL
    });
  }, [selectedOverlayFeature]);

  const layers = useMemo(() => [baseLayer, vacancyLayer, overlayLayer].filter(Boolean), [baseLayer, vacancyLayer, overlayLayer]);

  const selectedProps = selectedFeature?.properties;
  const buildingName = getBuildingName(selectedProps);
  const buildingUse = getBuildingUse(selectedProps);
  const address = formatAddress(selectedProps);
  const stories = getStories(selectedProps);
  const footprintArea = getFootprintAreaM2(selectedFeature ?? undefined);
  const floors = stories ?? getFloors(selectedProps?.height);
  const totalArea = getTotalAreaM2(footprintArea, floors);
  const activeVacancy = selectedProps
    ? getActiveVacancy(selectedProps, submittedAvailableAreaById, selectedProps?.id, totalArea)
    : null;
  const vacancy = formatVacancyValue(activeVacancy);
  const height = formatHeight(selectedProps);
  const formattedFootprint = formatArea(footprintArea);
  const formattedTotalArea = formatArea(totalArea);
  const selectedDraftAvailableArea = selectedProps?.id ? draftAvailableAreaById[selectedProps.id] : '';
  const hasStoredVacancy = selectedProps ? hasVacancyData(selectedProps) : false;
  const hasSubmittedVacancy =
    selectedProps?.id && Object.prototype.hasOwnProperty.call(submittedAvailableAreaById, selectedProps.id);
  const isReportOpen = selectedProps?.id ? reportOpenById[selectedProps.id] : false;
  const showOverrideInput = selectedProps ? !hasStoredVacancy && totalArea !== null : false;
  const showVacancyValue = hasStoredVacancy || (hasSubmittedVacancy && (activeVacancy ?? 0) > 0);

  const onDraftAvailableAreaChange = useCallback(
    (id: string, value: string) => {
      setDraftAvailableAreaById((prev) => ({ ...prev, [id]: value }));
    },
    []
  );

  const onSubmitAvailableArea = useCallback(
    (id: string) => {
      setSubmittedAvailableAreaById((prev) => {
        const draft = draftAvailableAreaById[id];
        if (!draft?.trim()) return prev;
        const parsed = Number(draft);
        if (!Number.isFinite(parsed)) return prev;
        const clamped = Math.max(parsed, 0);
        return { ...prev, [id]: clamped };
      });
      setReportOpenById((prev) => ({ ...prev, [id]: false }));
    },
    [draftAvailableAreaById]
  );

  const onClearReport = useCallback((id: string) => {
    setSubmittedAvailableAreaById((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, id)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setDraftAvailableAreaById((prev) => ({ ...prev, [id]: '' }));
    setReportOpenById((prev) => ({ ...prev, [id]: false }));
  }, []);

  const onMapLoad = useCallback((event: { target: maplibregl.Map }) => {
    const map = event?.target;
    const style = map?.getStyle();
    const layers = style?.layers;
    if (!layers) return;

    const blockedSubstrings = ['road', 'street', 'highway', 'transport', 'bridge', 'tunnel'];
    const protectedSubstrings = ['building', 'vacancy', 'base-buildings', 'vacancy-volumes'];

    layers.forEach((layer) => {
      if (!layer?.id) return;
      const id = layer.id.toLowerCase();
      if (protectedSubstrings.some((token) => id.includes(token))) return;

      const isSymbol = layer.type === 'symbol';
      const matchesBlocked = blockedSubstrings.some((token) => id.includes(token));
      if (!isSymbol && !matchesBlocked) return;

      try {
        map.setLayoutProperty(layer.id, 'visibility', 'none');
      } catch (error) {
        console.warn('Unable to hide base map layer', layer.id, error);
      }
    });
  }, []);

  return (
    <div className="layout">
      <div className="map-container">
        <div className="search-panel">
          <label htmlFor="building-search" className="search-label">
            Search
          </label>
          <input
            id="building-search"
            type="text"
            placeholder="Search address or building name…"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setSearchOpen(false)}
          />
          {searchOpen && (
            <div className="search-results" onMouseDown={(event) => event.preventDefault()}>
              {searchLoading ? (
                <div className="search-status">Loading…</div>
              ) : searchResults.length ? (
                searchResults.map((result, index) => (
                  <button
                    key={result.id ?? result.address ?? `result-${index}`}
                    type="button"
                    className="search-result"
                    onClick={() => onSearchSelect(result)}
                  >
                    {formatSearchResult(result)}
                  </button>
                ))
              ) : debouncedSearchQuery.trim() ? (
                <div className="search-status">No results</div>
              ) : null}
            </div>
          )}
        </div>
        <DeckGL layers={layers} initialViewState={INITIAL_VIEW_STATE} controller={{ dragRotate: true, touchRotate: true }}>
          <Map
            mapLib={maplibregl}
            mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
            attributionControl={true}
            onLoad={onMapLoad}
            ref={mapRef}
          />
        </DeckGL>
        <div className="legend">
          <div>
            <span className="swatch" style={{ background: toCssRgba(BASE_COLOR) }} /> Base building
          </div>
          <div>
            <span className="swatch" style={{ background: toCssRgba(VACANCY_COLOR) }} /> Internal vacancy volume
          </div>
        </div>
      </div>
      <aside className="sidebar">
        {selectedFeature ? (
          <>
            <h2>Building details</h2>
          <dl>
            {buildingName && (
              <>
                <dt>Building Name</dt>
                <dd>{buildingName}</dd>
              </>
            )}
            {buildingUse && (
              <>
                <dt>Building current use</dt>
                <dd>{buildingUse}</dd>
              </>
            )}
            {address && (
              <>
                <dt>Address</dt>
                <dd>{address}</dd>
              </>
            )}
            {stories && (
              <>
                <dt>Stories</dt>
                <dd>{stories}</dd>
              </>
            )}
            {formattedFootprint && (
              <>
                <dt>Footprint area</dt>
                <dd>{formattedFootprint}</dd>
              </>
            )}
            {formattedTotalArea && (
              <>
                <dt>Total building area</dt>
                <dd>{formattedTotalArea}</dd>
              </>
            )}
            {showOverrideInput && selectedProps?.id && (
              <>
                <dt>Vacancy report</dt>
                <dd>
                  {!isReportOpen ? (
                    <button
                      type="button"
                      onClick={() => setReportOpenById((prev) => ({ ...prev, [selectedProps.id]: true }))}
                    >
                      Report vacancy
                    </button>
                  ) : (
                    <div className="vacancy-report">
                      <label>
                        <span>Available area for rent (m²)</span>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={selectedDraftAvailableArea}
                          onChange={(e) => onDraftAvailableAreaChange(selectedProps.id as string, e.target.value)}
                        />
                      </label>
                      <button type="button" onClick={() => onSubmitAvailableArea(selectedProps.id as string)}>
                        Submit
                      </button>
                      {hasSubmittedVacancy && (
                        <button type="button" className="link-button" onClick={() => onClearReport(selectedProps.id as string)}>
                          Clear report
                        </button>
                      )}
                    </div>
                  )}
                </dd>
              </>
            )}
            {showVacancyValue && vacancy && (
              <>
                <dt>Percentage vacant</dt>
                <dd>{vacancy}</dd>
              </>
            )}
            {height && (
              <>
                <dt>Building height</dt>
                <dd>{height}</dd>
              </>
            )}
          </dl>
          <div className="model-actions">
            <button type="button" onClick={handleGenerateModel} disabled={modelState.status === 'loading'}>
              {modelState.status === 'loading' ? 'Generating…' : 'Generate model'}
            </button>
            {modelState.status === 'error' && modelState.message && (
              <div className="search-status">{modelState.message}</div>
            )}
            {modelState.status === 'ready' && modelState.url && (
              <>
                <ModelViewer className="model-viewer" src={modelState.url} />
                {modelState.notes && <div className="search-status">{modelState.notes}</div>}
              </>
            )}
          </div>
          </>
        ) : (
          <div className="placeholder">Select a building to display information</div>
        )}
      </aside>
    </div>
  );
}
