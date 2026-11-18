import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { searchActivityPlaces } from "./activity-place-search.ts";

const endpoint = "https://api.geoapify.com/v1/geocode/search";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("returns qualified places in provider order for the typed query", async () => {
  server.use(
    http.get(endpoint, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(Object.fromEntries(params)).toEqual({
        apiKey: "test-key",
        text: "Oakland, CA",
        format: "json",
        lang: "en",
        limit: "5",
      });
      return HttpResponse.json({
        results: [
          {
            place_id: "oakland-ca",
            formatted: "Oakland, California, United States",
            lat: 37.8045,
            lon: -122.2714,
          },
          {
            place_id: "oakland-or",
            formatted: "Oakland, Oregon, United States",
            lat: 43.4221,
            lon: -123.2985,
          },
        ],
      });
    }),
  );

  await expect(searchActivityPlaces("Oakland, CA", "test-key")).resolves.toEqual([
    {
      id: "oakland-ca",
      label: "Oakland, California, United States",
      latitude: 37.8045,
      longitude: -122.2714,
    },
    {
      id: "oakland-or",
      label: "Oakland, Oregon, United States",
      latitude: 43.4221,
      longitude: -123.2985,
    },
  ]);
});

it("returns an empty list when no place matches", async () => {
  server.use(http.get(endpoint, () => HttpResponse.json({ results: [] })));
  await expect(searchActivityPlaces("Unknown place", "test-key")).resolves.toEqual([]);
});

it("surfaces provider HTTP failures without including the key or response body", async () => {
  server.use(http.get(endpoint, () => new HttpResponse("test-key", { status: 429 })));
  await expect(searchActivityPlaces("Oakland", "test-key")).rejects.toThrow(
    /^Geoapify place search failed with HTTP 429\.$/,
  );
});

it("rejects redirects to a different place lookup origin", async () => {
  const destination = "https://example.test/redirected";
  server.use(
    http.get(
      endpoint,
      () => new HttpResponse(null, { status: 302, headers: { location: destination } }),
    ),
    http.get(destination, () => HttpResponse.json({ results: [] })),
  );
  await expect(searchActivityPlaces("Oakland", "test-key")).rejects.toThrow();
});

it("rejects invalid provider coordinates", async () => {
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({
        results: [{ place_id: "invalid", formatted: "Invalid", lat: 91, lon: 0 }],
      }),
    ),
  );
  await expect(searchActivityPlaces("Oakland", "test-key")).rejects.toThrow(
    "Geoapify returned an invalid place search response.",
  );
});

it("rejects malformed JSON without exposing text from the response", async () => {
  server.use(http.get(endpoint, () => HttpResponse.text("Private Gym details")));
  await expect(searchActivityPlaces("Private Gym", "test-key")).rejects.toThrow(
    /^Geoapify returned an invalid place search response\.$/,
  );
});
