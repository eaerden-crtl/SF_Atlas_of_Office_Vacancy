'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';

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

function toCssRgba(color: readonly number[]): string {
  const [r, g, b, a] = color;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
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

function formatVacancy(props?: BuildingProperties): string | null {
  if (!props) return null;

  const raw = props.Percentage_vacant ?? props.percentage_vacant;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;

  return `${Math.round(value * 100)}%`;
}

function formatHeight(props?: BuildingProperties): string | null {
  if (!props) return null;

  const height = Number(props.height);
  if (!Number.isFinite(height)) return null;

  return `${height} m`;
}

type BuildingFeature = Feature<Geometry, BuildingProperties & { vacancyHeight?: number; baseOffset?: number }>;

export default function MapView() {
  const [collection, setCollection] = useState<FeatureCollection<Geometry, BuildingProperties>>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [selectedFeature, setSelectedFeature] = useState<BuildingFeature | null>(null);

  useEffect(() => {
    fetch('/data/SF_Final.geojson')
      .then((res) => res.json())
      .then((json) => setCollection(json as FeatureCollection<Geometry, BuildingProperties>))
      .catch((error) => {
        console.error('Failed to load GeoJSON', error);
      });
  }, []);

  useEffect(() => {
    if (!collection) return;

    if (selectedId) {
      const match = collection.features.find((f) => f.properties?.id === selectedId);
      if (match) {
        setSelectedFeature(match as BuildingFeature);
      }
    }
  }, [collection, selectedId]);

  const vacancyFeatures = useMemo(() => {
    if (!collection) return [];

    return collection.features
      .map((feature) => {
        const props = feature.properties || {};
        const height = Number(props.height);
        const rawVacancy = Number(props.Percentage_vacant);
        const vacancyShare = Number.isFinite(rawVacancy) ? Math.min(Math.max(rawVacancy, 0), 1) : 0;

        if (!Number.isFinite(height) || height <= 0 || vacancyShare <= 0) {
          return null;
        }

        const vacancyHeight = height * vacancyShare;
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
  }, [collection]);

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
  const vacancy = formatVacancy(selectedProps);
  const height = formatHeight(selectedProps);

  return (
    <div className="layout">
      <div className="map-container">
        <DeckGL layers={layers} initialViewState={INITIAL_VIEW_STATE} controller={{ dragRotate: true, touchRotate: true }}>
          <Map
            mapLib={maplibregl}
            mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
            attributionControl={true}
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
        <h2>Building details</h2>
        {selectedFeature ? (
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
            {vacancy && (
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
        ) : (
          <div className="placeholder">Click a building to view its attributes.</div>
        )}
      </aside>
    </div>
  );
}
