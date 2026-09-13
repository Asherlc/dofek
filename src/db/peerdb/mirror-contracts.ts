export interface PeerDbTableMapping {
  sourceTableIdentifier: string;
  destinationTableIdentifier: string;
  exclude: readonly string[];
}

interface PeerDbProcessingMarkerContract {
  destinationTableIdentifier: string;
  flow: string;
}

interface PeerDbMirrorContract {
  initialCopyPlaceholder:
    | "FITNESS_RAW_ANALYTICS_DO_INITIAL_COPY"
    | "PROVIDER_INVENTORY_RAW_ANALYTICS_DO_INITIAL_COPY"
    | "SENSOR_PRIORITY_RAW_ANALYTICS_DO_INITIAL_COPY";
  name:
    | "dofek_fitness_raw_analytics"
    | "dofek_provider_inventory_raw_analytics"
    | "dofek_sensor_priority_raw_analytics";
  processingMarker?: PeerDbProcessingMarkerContract;
  tableMappings: readonly PeerDbTableMapping[];
}

export const peerDbMirrorContracts = [
  {
    name: "dofek_fitness_raw_analytics",
    initialCopyPlaceholder: "FITNESS_RAW_ANALYTICS_DO_INITIAL_COPY",
    processingMarker: {
      destinationTableIdentifier: "processing_flow_marker",
      flow: "dofek_fitness_raw_analytics",
    },
    tableMappings: [
      {
        sourceTableIdentifier: "fitness.activity",
        destinationTableIdentifier: "activity",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.sleep_session",
        destinationTableIdentifier: "sleep_session",
        exclude: [
          "sleep_need_baseline_minutes",
          "sleep_need_from_debt_minutes",
          "sleep_need_from_nap_minutes",
          "sleep_need_from_strain_minutes",
        ],
      },
      {
        sourceTableIdentifier: "fitness.sleep_stage",
        destinationTableIdentifier: "sleep_stage",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.daily_metrics",
        destinationTableIdentifier: "daily_metrics",
        exclude: ["recovery_high_minutes", "resilience_level", "stress_high_minutes"],
      },
      {
        sourceTableIdentifier: "fitness.provider",
        destinationTableIdentifier: "provider",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.provider_connection",
        destinationTableIdentifier: "provider_connection",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.provider_priority",
        destinationTableIdentifier: "provider_priority",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.device_priority",
        destinationTableIdentifier: "device_priority",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.processing_flow_marker",
        destinationTableIdentifier: "processing_flow_marker",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.user_profile",
        destinationTableIdentifier: "user_profile",
        exclude: [],
      },
    ],
  },
  {
    name: "dofek_provider_inventory_raw_analytics",
    initialCopyPlaceholder: "PROVIDER_INVENTORY_RAW_ANALYTICS_DO_INITIAL_COPY",
    processingMarker: {
      destinationTableIdentifier: "processing_flow_marker_provider_inventory",
      flow: "dofek_provider_inventory_raw_analytics",
    },
    tableMappings: [
      {
        sourceTableIdentifier: "fitness.food_entry",
        destinationTableIdentifier: "food_entry",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.health_event",
        destinationTableIdentifier: "health_event",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.clinical_record",
        destinationTableIdentifier: "clinical_record",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.journal_entry",
        destinationTableIdentifier: "journal_entry",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.processing_flow_marker",
        destinationTableIdentifier: "processing_flow_marker_provider_inventory",
        exclude: [],
      },
    ],
  },
  {
    name: "dofek_sensor_priority_raw_analytics",
    initialCopyPlaceholder: "SENSOR_PRIORITY_RAW_ANALYTICS_DO_INITIAL_COPY",
    processingMarker: undefined,
    tableMappings: [
      {
        sourceTableIdentifier: "fitness.sensor_provider_priority",
        destinationTableIdentifier: "sensor_provider_priority",
        exclude: [],
      },
      {
        sourceTableIdentifier: "fitness.sensor_device_priority",
        destinationTableIdentifier: "sensor_device_priority",
        exclude: [],
      },
    ],
  },
] as const satisfies readonly PeerDbMirrorContract[];

export type PeerDbMirrorName = (typeof peerDbMirrorContracts)[number]["name"];

export function renderPeerDbTableMappings(tableMappings: readonly PeerDbTableMapping[]): string {
  return tableMappings
    .map(({ sourceTableIdentifier, destinationTableIdentifier, exclude }) => {
      const fields = [
        `    from: ${sourceTableIdentifier}`,
        `    to: ${destinationTableIdentifier}`,
        ...(exclude.length > 0 ? [`    exclude: [${exclude.join(", ")}]`] : []),
      ];
      return `  {\n${fields.join(",\n")}\n  }`;
    })
    .join(",\n");
}
