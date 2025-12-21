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
  [key: string]: unknown;
}

const INITIAL_VIEW_STATE = {
  longitude: -122.4194,
  latitude: 37.7749,
  zoom: 12.8,
  pitch: 60,
  bearing: -20
};

const BASE_COLOR = [160, 160, 160, 220];
const BASE_HIGHLIGHT = [120, 136, 248, 240];
const VACANCY_COLOR = [239, 90, 50, 220];
const VACANCY_HIGHLIGHT = [255, 140, 90, 240];

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
      getLineColor: [100, 100, 100],
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
      getLineColor: [200, 90, 50],
      onClick: onFeatureClick,
      updateTriggers: {
        getFillColor: [selectedId]
      }
    });
  }, [vacancyFeatures, selectedId, onFeatureClick]);

  const layers = useMemo(() => [baseLayer, vacancyLayer].filter(Boolean), [baseLayer, vacancyLayer]);

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
          <div><span className="swatch" style={{ background: 'rgba(160,160,160,0.86)' }} /> Base building</div>
          <div><span className="swatch" style={{ background: 'rgba(239,90,50,0.86)' }} /> Internal vacancy volume</div>
        </div>
      </div>
      <aside className="sidebar">
        <h2>Building details</h2>
        {selectedFeature ? (
          <dl>
            <dt>ID</dt>
            <dd>{selectedFeature.properties?.id ?? 'Unknown'}</dd>
            <dt>Number</dt>
            <dd>{selectedFeature.properties?.number ?? '—'}</dd>
            <dt>Street</dt>
            <dd>{selectedFeature.properties?.street ?? '—'}</dd>
            <dt>Postcode</dt>
            <dd>{selectedFeature.properties?.postcode ?? '—'}</dd>
            <dt>Height (m)</dt>
            <dd>{selectedFeature.properties?.height ?? '—'}</dd>
            <dt>Percentage vacant</dt>
            <dd>
              {Number.isFinite(Number(selectedFeature.properties?.Percentage_vacant))
                ? `${(Number(selectedFeature.properties?.Percentage_vacant) * 100).toFixed(1)}%`
                : '—'}
            </dd>
          </dl>
        ) : (
          <div className="placeholder">Click a building to view its attributes.</div>
        )}
      </aside>
    </div>
  );
}
