import type { Geometry } from 'geojson';

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8000';

export interface SearchResult {
  id?: string;
  score?: number;
  address?: string;
  number?: string;
  street?: string;
  postcode?: string;
  height_m?: number;
  vacancy_pct?: number;
}

export interface BuildingDetailResponse {
  found: boolean;
  id?: string;
  address?: string;
  height_m?: number;
  vacancy_pct?: number;
  properties?: Record<string, unknown>;
  geometry?: Geometry;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`);
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.warn('API request failed', error);
    return null;
  }
}

export async function searchBuildings(query: string): Promise<SearchResult[]> {
  const data = await fetchJson<SearchResult[]>(`/search?query=${encodeURIComponent(query)}`);
  return data ?? [];
}

export async function fetchBuildingByAddress(query: string): Promise<BuildingDetailResponse | null> {
  return fetchJson<BuildingDetailResponse>(`/building_by_address?query=${encodeURIComponent(query)}`);
}

export async function fetchBuildingById(id: string): Promise<BuildingDetailResponse | null> {
  return fetchJson<BuildingDetailResponse>(`/building?id=${encodeURIComponent(id)}`);
}
