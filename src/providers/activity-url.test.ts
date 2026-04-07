import { describe, expect, it } from "vitest";

import { Concept2Provider } from "./concept2.ts";
import { CyclingAnalyticsProvider } from "./cycling-analytics.ts";
import { DecathlonProvider } from "./decathlon.ts";
import { FitbitProvider } from "./fitbit/provider.ts";
import { GarminProvider } from "./garmin.ts";
import { KomootProvider } from "./komoot.ts";
import { PelotonProvider } from "./peloton.ts";
import { PolarProvider } from "./polar.ts";
import { RideWithGpsProvider } from "./ride-with-gps.ts";
import { StravaProvider } from "./strava.ts";
import { SuuntoProvider } from "./suunto.ts";
import { TrainerRoadProvider } from "./trainerroad.ts";
import { VeloHeroProvider } from "./velohero.ts";
import { WahooProvider } from "./wahoo/index.ts";
import { XertProvider } from "./xert.ts";
import { ZwiftProvider } from "./zwift.ts";

describe("activityUrl", () => {
  const cases: Array<{
    name: string;
    provider: { activityUrl(id: string): string };
    expected: string;
  }> = [
    {
      name: "Strava",
      provider: new StravaProvider(),
      expected: "https://www.strava.com/activities/123",
    },
    {
      name: "Garmin",
      provider: new GarminProvider(),
      expected: "https://connect.garmin.com/modern/activity/123",
    },
    {
      name: "Wahoo",
      provider: new WahooProvider(),
      expected: "https://cloud.wahoo.com/workouts/123",
    },
    {
      name: "Peloton",
      provider: new PelotonProvider(),
      expected: "https://members.onepeloton.com/profile/workouts/123",
    },
    {
      name: "Polar",
      provider: new PolarProvider(),
      expected: "https://flow.polar.com/training/analysis/123",
    },
    {
      name: "Zwift",
      provider: new ZwiftProvider(),
      expected: "https://www.zwift.com/activity/123",
    },
    {
      name: "Fitbit",
      provider: new FitbitProvider(),
      expected: "https://www.fitbit.com/activities/exercise/123",
    },
    { name: "Komoot", provider: new KomootProvider(), expected: "https://www.komoot.com/tour/123" },
    {
      name: "Suunto",
      provider: new SuuntoProvider(),
      expected: "https://www.sports-tracker.com/workout/123",
    },
    {
      name: "Ride with GPS",
      provider: new RideWithGpsProvider(),
      expected: "https://ridewithgps.com/trips/123",
    },
    {
      name: "Concept2",
      provider: new Concept2Provider(),
      expected: "https://log.concept2.com/results/123",
    },
    {
      name: "Cycling Analytics",
      provider: new CyclingAnalyticsProvider(),
      expected: "https://www.cyclinganalytics.com/ride/123",
    },
    {
      name: "TrainerRoad",
      provider: new TrainerRoadProvider(),
      expected: "https://www.trainerroad.com/app/cycling/rides/123",
    },
    {
      name: "Decathlon",
      provider: new DecathlonProvider(),
      expected: "https://www.decathlon.com/sports-tracking/activity/123",
    },
    {
      name: "Xert",
      provider: new XertProvider(),
      expected: "https://www.xertonline.com/activities/123",
    },
    {
      name: "VeloHero",
      provider: new VeloHeroProvider(),
      expected: "https://app.velohero.com/workouts/show/123",
    },
  ];

  for (const { name, provider, expected } of cases) {
    it(`${name} returns correct activity URL`, () => {
      expect(provider.activityUrl("123")).toBe(expected);
    });
  }
});
