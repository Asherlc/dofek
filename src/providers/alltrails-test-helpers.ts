/** Synthetic fixtures based on the signed Android 19.0.2 recording contract. */
export function encodeAllTrailsPoints(points: readonly (readonly number[])[]): string {
  const multipliers = [100_000, 100_000, 100_000, 100, 100_000, 100_000];
  const previous = multipliers.map(() => 0n);
  let encoded = "";
  for (const point of points) {
    for (let axis = 0; axis < multipliers.length; axis++) {
      const multiplier = multipliers[axis];
      const component = point[axis];
      const prior = previous[axis];
      if (multiplier === undefined || component === undefined || prior === undefined) {
        throw new Error("AllTrails test points require six components");
      }
      const value = BigInt(Math.round(component * multiplier));
      const delta = value - prior;
      previous[axis] = value;
      let unsigned = delta < 0n ? -delta * 2n - 1n : delta * 2n;
      while (unsigned >= 32n) {
        encoded += String.fromCharCode(Number((unsigned & 31n) | 32n) + 63);
        unsigned >>= 5n;
      }
      encoded += String.fromCharCode(Number(unsigned) + 63);
    }
  }
  return encoded;
}

export function allTrailsRecording(id = 101) {
  const epoch = Date.parse("2026-10-10T17:00:00Z") / 1000;
  const segments = [
    [
      [37.75, -122.45, 12.5, epoch, 4, 4],
      [37.7501, -122.4501, 13.25, epoch + 10.25, 3, 3],
    ],
    [
      [37.7502, -122.4502, 14, epoch + 300, 5, 5],
      [37.7503, -122.4503, 13.75, epoch + 315.5, 4, 4],
    ],
  ];
  return {
    id,
    name: `Morning hike ${id}`,
    presentationType: "track",
    activity: { uid: "hiking", name: "Hiking" },
    metadata: {
      created: "2026-10-11T12:00:00Z",
      updated: "2026-10-12T12:00:00Z",
      timezone: "America/Los_Angeles",
    },
    summaryStats: { calories: 900, distanceTotal: 9_999, timeTotal: 9_999 },
    tracks: [
      {
        id: id * 10,
        name: "Track",
        lineTimedSegments: segments.map((points, index) => ({
          id: id * 100 + index,
          sequence_num: index,
          polyline: { ndimensionalData: encodeAllTrailsPoints(points) },
        })),
      },
    ],
  };
}
