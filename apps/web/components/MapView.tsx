'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import area from '@turf/area';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fetchBuildingById, searchBuildings } from '../src/lib/api';

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

const INITIAL_VIEW_STATE = {
  longitude: -122.4194,
  latitude: 37.7749,
  zoom: 12.8,
  pitch: 60,
  bearing: -20
};

const BASE_COLOR = [190, 220, 235, 180] as const;
const BASE_HIGHLIGHT = [160, 200, 230, 240] as const;
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
  const [draftAvailableAreaById, setDraftAvailableAreaById] = useState<Record<string, string>>({});
  const [submittedAvailableAreaById, setSubmittedAvailableAreaById] = useState<Record<string, number | undefined>>({});
  const [reportOpenById, setReportOpenById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let isMounted = true;

    const loadInitialBuildings = async () => {
      const results = await searchBuildings('a');
      if (!results.length) return;

      const detailResponses = await Promise.all(
        results
          .map((result) => result.id)
          .filter((id): id is string => Boolean(id))
          .map((id) => fetchBuildingById(id))
      );

      const features = detailResponses
        .filter((response): response is NonNullable<typeof response> => Boolean(response))
        .filter((response) => response.found && response.geometry)
        .map((response) => ({
          type: 'Feature',
          geometry: convertGeometry(response.geometry as Geometry),
          properties: {
            ...(response.properties ?? {}),
            id: response.id ?? response.properties?.id
          }
        })) as Feature<Geometry, BuildingProperties>[];

      if (!isMounted || !features.length) return;
      setCollection({ type: 'FeatureCollection', features });
    };

    loadInitialBuildings().catch((error) => {
      console.warn('Failed to load initial buildings', error);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;

    let isActive = true;

    const loadSelectedBuilding = async () => {
      const response = await fetchBuildingById(selectedId);
      if (!response || !response.found || !response.geometry) return;

      const feature: BuildingFeature = {
        type: 'Feature',
        geometry: convertGeometry(response.geometry as Geometry),
        properties: {
          ...(response.properties ?? {}),
          id: response.id ?? response.properties?.id
        }
      };

      if (isActive) {
        setSelectedFeature(feature);
      }
    };

    loadSelectedBuilding().catch((error) => {
      console.warn('Failed to load building details', error);
    });

    return () => {
      isActive = false;
    };
  }, [selectedId]);

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
    if (info.object) {
      const id = info.object.properties?.id;
      setSelectedId(id);
      setSelectedFeature(info.object);
    }
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

  const layers = useMemo(() => [baseLayer, vacancyLayer].filter(Boolean), [baseLayer, vacancyLayer]);

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
        <DeckGL layers={layers} initialViewState={INITIAL_VIEW_STATE} controller={{ dragRotate: true, touchRotate: true }}>
          <Map
            mapLib={maplibregl}
            mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
            attributionControl={true}
            onLoad={onMapLoad}
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
          </>
        ) : (
          <div className="placeholder">Select a building to display information</div>
        )}
      </aside>
    </div>
  );
}
