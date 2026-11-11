import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

/** Groups Axiom log metadata without changing records shared with other exporters. */
export class AxiomLogExporter implements LogRecordExporter {
  readonly #exporter: LogRecordExporter;

  constructor(exporter: LogRecordExporter) {
    this.#exporter = exporter;
  }

  export(
    records: ReadableLogRecord[],
    resultCallback: Parameters<LogRecordExporter["export"]>[1],
  ): void {
    this.#exporter.export(
      records.map((record) => {
        const { custom, ...attributes } = record.attributes;
        const customAttributes =
          custom !== null &&
          typeof custom === "object" &&
          !Array.isArray(custom) &&
          !(custom instanceof Uint8Array)
            ? { ...attributes, ...custom }
            : record.attributes;

        return {
          hrTime: record.hrTime,
          hrTimeObserved: record.hrTimeObserved,
          spanContext: record.spanContext,
          severityText: record.severityText,
          severityNumber: record.severityNumber,
          body: record.body,
          eventName: record.eventName,
          resource: record.resource,
          instrumentationScope: record.instrumentationScope,
          attributes: { custom: customAttributes },
          droppedAttributesCount: record.droppedAttributesCount,
        };
      }),
      resultCallback,
    );
  }

  forceFlush(): Promise<void> {
    return this.#exporter.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.#exporter.shutdown();
  }
}
