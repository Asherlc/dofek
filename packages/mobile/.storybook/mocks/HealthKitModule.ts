const emptySubscription = {
  remove: () => {},
};

const HealthKitModule = {
  getRequestStatus: async () => "unavailable",
  requestPermissions: async () => false,
  hasEverAuthorized: () => false,
  isAvailable: () => false,
  queryQuantitySamples: async () => [],
  queryWorkouts: async () => [],
  querySleepSamples: async () => [],
  queryDailyStatistics: async () => [],
  queryWorkoutRoutes: async () => [],
  writeDietaryEnergy: async () => false,
  getAnchor: async () => 0,
  queryAnchoredSamples: async () => ({
    samples: [],
    deletedUUIDs: [],
    newAnchor: 0,
  }),
  isBackgroundDeliveryEnabled: () => false,
  enableBackgroundDelivery: async () => false,
  setupBackgroundObservers: async () => false,
  addListener: () => emptySubscription,
};

export default HealthKitModule;
