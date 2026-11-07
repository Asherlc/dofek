import kafkaJs, { type ConfigResourceTypes } from "kafkajs";

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

interface KafkaQuarantineAdmin {
  alterConfigs(options: {
    resources: {
      type: ConfigResourceTypes;
      name: string;
      configEntries: { name: string; value: string }[];
    }[];
  }): Promise<unknown>;
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
    await this.#admin.createTopics({
      topics: [
        {
          configEntries: METRIC_STREAM_QUARANTINE_TOPIC_CONFIG,
          topic: this.#topic,
        },
      ],
      waitForLeaders: true,
    });
    await this.#admin.alterConfigs({
      resources: [
        {
          configEntries: METRIC_STREAM_QUARANTINE_TOPIC_CONFIG,
          name: this.#topic,
          type: kafkaJs.ConfigResourceTypes.TOPIC,
        },
      ],
    });
    await this.#admin.disconnect();
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
}
