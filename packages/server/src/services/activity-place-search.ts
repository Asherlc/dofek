import { z } from "zod";

export const activityPlaceCoordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const activityPlaceSchema = activityPlaceCoordinatesSchema.extend({
  id: z.string().min(1),
  label: z.string().min(1),
});

const geoapifyResponseSchema = z.object({
  results: z.array(
    z.object({
      place_id: activityPlaceSchema.shape.id,
      formatted: activityPlaceSchema.shape.label,
      lat: activityPlaceCoordinatesSchema.shape.latitude,
      lon: activityPlaceCoordinatesSchema.shape.longitude,
    }),
  ),
});

export async function searchActivityPlaces(query: string, apiKey: string) {
  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.search = new URLSearchParams({
    apiKey,
    text: query,
    format: "json",
    lang: "en",
    limit: "5",
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  if (!response.ok) {
    throw new Error(`Geoapify place search failed with HTTP ${response.status}.`);
  }
  const parsed = geoapifyResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error("Geoapify returned an invalid place search response.");
  return parsed.data.results.map((place) => ({
    id: place.place_id,
    label: place.formatted,
    latitude: place.lat,
    longitude: place.lon,
  }));
}
