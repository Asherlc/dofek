import kafkaJs, { type ConfigResourceTypes } from "kafkajs";
import { z } from "zod";

export const METRIC_STREAM_QUARANTINE_RETENTION_MS = "604800000";
export const METRIC_STREAM_QUARANTINE_RETENTION_BYTES = "1073741824";
export const METRIC_STREAM_QUARANTINE_TOPIC_SUFFIX = ".quarantine.v1";

export const METRIC_STREAM_QUARANTINE_TOPIC_CONFIG = [
  { name: "cleanup.policy", value: "delete" },
  { name: "retention.ms", value: METRIC_STREAM_QUARANTINE_RETENTION_MS },
  { name: "retention.bytes", value: METRIC_STREAM_QUARANTINE_RETENTION_BYTES },
];

export function metricStreamQuarantineTopic(sourceTopic: string): string {
  return `${sourceTopic}${METRIC_STREAM_QUARANTINE_TOPIC_SUFFIX}`;
}

export interface KafkaQuarantineConfigAdmin {
  describeConfigs(options: {
    includeSynonyms: boolean;
    resources: Array<{
      type: ConfigResourceTypes;
      name: string;
      configNames: string[];
    }>;
  }): Promise<unknown>;
}

const describedTopicConfigSchema = z.object({
  resources: z
    .array(
      z.object({
        configEntries: z.array(
          z.object({
            configName: z.string(),
            configValue: z.string().nullable(),
          }),
        ),
        errorCode: z.number().int(),
        errorMessage: z.string().nullable(),
        resourceName: z.string(),
        resourceType: z.number().int(),
      }),
    )
    .length(1),
});

export async function assertQuarantineTopicConfiguration(
  admin: KafkaQuarantineConfigAdmin,
  quarantineTopic: string,
): Promise<void> {
  const response = describedTopicConfigSchema.safeParse(
    await admin.describeConfigs({
      includeSynonyms: false,
      resources: [
        {
          configNames: METRIC_STREAM_QUARANTINE_TOPIC_CONFIG.map((entry) => entry.name),
          name: quarantineTopic,
          type: kafkaJs.ConfigResourceTypes.TOPIC,
        },
      ],
    }),
  );
  const failure = `Kafka could not verify quarantine topic ${quarantineTopic}`;
  if (!response.success) {
    throw new Error(`${failure}: malformed DescribeConfigs response`, { cause: response.error });
  }
  const resource = response.data.resources[0];
  if (
    !resource ||
    resource.resourceName !== quarantineTopic ||
    resource.resourceType !== kafkaJs.ConfigResourceTypes.TOPIC
  ) {
    throw new Error(failure);
  }
  if (resource.errorCode !== 0) {
    throw new Error(`${failure}: ${resource.errorMessage ?? `broker error ${resource.errorCode}`}`);
  }
  for (const { name, value } of METRIC_STREAM_QUARANTINE_TOPIC_CONFIG) {
    const entries = resource.configEntries.filter((entry) => entry.configName === name);
    if (entries.length > 1) {
      throw new Error(`Quarantine topic ${quarantineTopic} has duplicate ${name} entries`);
    }
    const actualValue = entries[0]?.configValue;
    if (actualValue !== value) {
      throw new Error(
        `Quarantine topic ${quarantineTopic} ${name} must be ${value}; found ${actualValue === undefined ? "missing" : String(actualValue)}`,
      );
    }
  }
}

interface KafkaQuarantineAdmin extends KafkaQuarantineConfigAdmin {
  connect(): Promise<void>;
  createTopics(options: {
    topics: {
      topic: string;
      configEntries: { name: string; value: string }[];
    }[];
    waitForLeaders: boolean;
  }): Promise<boolean>;
  disconnect(): Promise<void>;
}

interface KafkaQuarantineProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(options: {
    topic: string;
    acks: -1;
    messages: {
      headers: Record<string, string>;
      key: string;
      value: Buffer;
    }[];
  }): Promise<unknown>;
}

export interface MetricStreamQuarantineInput {
  error: unknown;
  offset: string;
  partition: number;
  payload: Buffer;
  topic: string;
}

export interface MetricStreamQuarantineWriter {
  connect(): Promise<void>;
  write(input: MetricStreamQuarantineInput): Promise<void>;
}

interface KafkaMetricStreamQuarantineWriterOptions {
  admin: KafkaQuarantineAdmin;
  producer: KafkaQuarantineProducer;
  sourceTopic: string;
}

function serializeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }
  return {
    message: String(error),
    name: "NonError",
  };
}

export class KafkaMetricStreamQuarantineWriter implements MetricStreamQuarantineWriter {
  readonly #admin: KafkaQuarantineAdmin;
  readonly #producer: KafkaQuarantineProducer;
  readonly #topic: string;

  constructor(options: KafkaMetricStreamQuarantineWriterOptions) {
    this.#admin = options.admin;
    this.#producer = options.producer;
    this.#topic = metricStreamQuarantineTopic(options.sourceTopic);
  }

  async connect(): Promise<void> {
    await this.#admin.connect();
    try {
      await this.#admin.createTopics({
        topics: [{ configEntries: METRIC_STREAM_QUARANTINE_TOPIC_CONFIG, topic: this.#topic }],
        waitForLeaders: true,
      });
      await assertQuarantineTopicConfiguration(this.#admin, this.#topic);
    } finally {
      await this.#admin.disconnect();
    }
    await this.#producer.connect();
  }

  async write(input: MetricStreamQuarantineInput): Promise<void> {
    const error = serializeError(input.error);

    await this.#producer.send({
      acks: -1,
      messages: [
        {
          headers: {
            "dofek-error-message": error.message,
            "dofek-error-name": error.name,
            "dofek-quarantine-version": "1",
            "dofek-quarantined-at": new Date().toISOString(),
            "dofek-source-offset": input.offset,
            "dofek-source-partition": String(input.partition),
            "dofek-source-topic": input.topic,
          },
          key: `${input.topic}:${input.partition}:${input.offset}`,
          value: input.payload,
        },
      ],
      topic: this.#topic,
    });
  }

  disconnect(): Promise<void> {
    return this.#producer.disconnect();
  }
}
