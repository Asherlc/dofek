export type DeviceScopedSample = {
  deviceId?: string;
};

export class DeviceSampleGroups<InputSample extends DeviceScopedSample, UploadSample> {
  #groups = new Map<string, UploadSample[]>();
  #fallbackDeviceId: string | null;
  #toUploadSample: (sample: InputSample) => UploadSample;

  constructor(
    fallbackDeviceId: string | null,
    toUploadSample: (sample: InputSample) => UploadSample,
  ) {
    this.#fallbackDeviceId = fallbackDeviceId;
    this.#toUploadSample = toUploadSample;
  }

  add(sample: InputSample): void {
    const deviceId = sample.deviceId?.trim() || this.#fallbackDeviceId;
    if (!deviceId) {
      throw new Error("Buffered sample is missing deviceId");
    }

    const uploadSample = this.#toUploadSample(sample);
    const group = this.#groups.get(deviceId);
    if (group) {
      group.push(uploadSample);
      return;
    }

    this.#groups.set(deviceId, [uploadSample]);
  }

  entries(): Array<[string, UploadSample[]]> {
    return Array.from(this.#groups.entries());
  }
}
