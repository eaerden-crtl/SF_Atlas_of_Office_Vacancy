import type { Feature, Geometry } from 'geojson';

interface BuildingProperties {
  id?: string;
  number?: string;
  street?: string;
  postcode?: string;
  names?: {
    primary?: string;
    common?: string;
  };
}

const WIKIPEDIA_SEARCH_ENDPOINT = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_SUMMARY_ENDPOINT = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const COMMONS_SEARCH_ENDPOINT = 'https://commons.wikimedia.org/w/api.php';

const GENERIC_TITLE_BLACKLIST = [
  'san francisco',
  'financial district',
  'san francisco, california',
  'bay bridge',
  'skyline',
  'downtown san francisco'
];

const SNIPPET_TAG_REGEX = /<[^>]+>/g;

function getBuildingName(props?: BuildingProperties): string | null {
  if (!props?.names) return null;
  const primary = typeof props.names.primary === 'string' ? props.names.primary.trim() : '';
  if (primary) return primary;
  const common = typeof props.names.common === 'string' ? props.names.common.trim() : '';
  return common || null;
}

function getAddressQuery(props?: BuildingProperties): string | null {
  if (!props) return null;
  const number = typeof props.number === 'string' ? props.number.trim() : '';
  const street = typeof props.street === 'string' ? props.street.trim() : '';
  const postcode = typeof props.postcode === 'string' ? props.postcode.trim() : '';

  const base = [number, street].filter(Boolean).join(' ').trim();
  if (!base) return null;

  const withPostcode = postcode ? `${base} ${postcode}` : base;
  return `${withPostcode}, San Francisco`;
}

function buildSearchQuery(props?: BuildingProperties): string | null {
  const name = getBuildingName(props);
  if (name) {
    return `${name} San Francisco building`;
  }

  const address = getAddressQuery(props);
  return address || null;
}

function isBlacklistedTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return GENERIC_TITLE_BLACKLIST.some((entry) => lower.includes(entry));
}

function stripSnippet(snippet: string): string {
  return snippet.replace(SNIPPET_TAG_REGEX, '');
}

function getMatchScore(
  title: string,
  snippet: string,
  options: { name?: string | null; street?: string | null; number?: string | null }
): number {
  const lowerTitle = title.toLowerCase();
  const lowerSnippet = stripSnippet(snippet).toLowerCase();
  let score = 0;

  if (options.name) {
    const name = options.name.toLowerCase();
    if (lowerTitle.includes(name) || lowerSnippet.includes(name)) {
      score += 3;
    }
  }

  if (options.number) {
    const number = options.number.toLowerCase();
    if (lowerTitle.includes(number) || lowerSnippet.includes(number)) {
      score += 2;
    }
  }

  if (options.street) {
    const street = options.street.toLowerCase();
    if (lowerTitle.includes(street) || lowerSnippet.includes(street)) {
      score += 1;
    }
  }

  return score;
}

async function fetchWikipediaImage(query: string, props?: BuildingProperties): Promise<string | null> {
  const searchUrl = `${WIKIPEDIA_SEARCH_ENDPOINT}?action=query&list=search&format=json&origin=*&srsearch=${encodeURIComponent(
    query
  )}`;
  const searchResponse = await fetch(searchUrl);
  const searchJson = await searchResponse.json();
  const results: { title: string; snippet?: string }[] = searchJson?.query?.search ?? [];

  const name = getBuildingName(props);
  const street = typeof props?.street === 'string' ? props.street.trim() : null;
  const number = typeof props?.number === 'string' ? props.number.trim() : null;

  const filtered = results.filter((result) => !isBlacklistedTitle(result.title));
  const scored = filtered
    .map((result) => ({
      ...result,
      score: getMatchScore(result.title, result.snippet ?? '', { name, street, number })
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score === 0) return null;

  const summaryUrl = `${WIKIPEDIA_SUMMARY_ENDPOINT}${encodeURIComponent(best.title)}`;
  const summaryResponse = await fetch(summaryUrl);
  const summaryJson = await summaryResponse.json();
  return summaryJson?.thumbnail?.source || summaryJson?.originalimage?.source || null;
}

async function fetchCommonsImage(query: string, props?: BuildingProperties): Promise<string | null> {
  const searchUrl = `${COMMONS_SEARCH_ENDPOINT}?action=query&list=search&format=json&origin=*&srsearch=${encodeURIComponent(
    query
  )}`;
  const searchResponse = await fetch(searchUrl);
  const searchJson = await searchResponse.json();
  const results: { title: string; snippet?: string }[] = searchJson?.query?.search ?? [];

  const name = getBuildingName(props);
  const street = typeof props?.street === 'string' ? props.street.trim() : null;
  const number = typeof props?.number === 'string' ? props.number.trim() : null;

  const fileResults = results
    .filter((result) => result.title.startsWith('File:'))
    .filter((result) => !isBlacklistedTitle(result.title));

  const scored = fileResults
    .map((result) => ({
      ...result,
      score: getMatchScore(result.title, result.snippet ?? '', { name, street, number })
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score === 0) return null;

  const infoUrl = `${COMMONS_SEARCH_ENDPOINT}?action=query&format=json&origin=*&titles=${encodeURIComponent(
    best.title
  )}&prop=imageinfo&iiprop=url`;
  const infoResponse = await fetch(infoUrl);
  const infoJson = await infoResponse.json();
  const pages = infoJson?.query?.pages ?? {};
  const firstPage = Object.values(pages)[0] as { imageinfo?: { url: string }[] } | undefined;
  return firstPage?.imageinfo?.[0]?.url ?? null;
}

export async function getBuildingImageUrl(feature: Feature<Geometry, BuildingProperties>): Promise<string | null> {
  const props = feature?.properties;
  const query = buildSearchQuery(props);
  if (!query) return null;

  const wikipediaImage = await fetchWikipediaImage(query, props);
  if (wikipediaImage) return wikipediaImage;

  return fetchCommonsImage(query, props);
}
