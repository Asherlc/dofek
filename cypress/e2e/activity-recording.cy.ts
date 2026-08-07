describe("Activity recording", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("saves a recorded activity with metric-stream samples", () => {
    cy.request({
      method: "POST",
      url: "/api/trpc/activityRecording.save?batch=1",
      body: {
        "0": {
          activityType: "running",
          startedAt: "2026-07-20T08:00:00.000Z",
          endedAt: "2026-07-20T08:05:00.000Z",
          name: "E2E recorded run",
          notes: null,
          sourceName: "Dofek iOS",
          samples: [
            {
              recordedAt: "2026-07-20T08:00:00.000Z",
              lat: 37.7749,
              lng: -122.4194,
              gpsAccuracy: 5,
              altitude: 15,
              speed: 3.2,
            },
          ],
        },
      },
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body[0].result.data.activityId).to.be.a("string").and.not.be.empty;
    });
  });
});
