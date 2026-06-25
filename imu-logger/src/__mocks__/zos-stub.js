export const Accelerometer = class Accelerometer {
  constructor() {
    this._freqMode = 1;
  }
  setFreqMode(m) {
    this._freqMode = m;
  }
  getFreqMode() {
    return this._freqMode;
  }
  onChange() {}
  offChange() {}
  start() {}
  stop() {}
  getCurrent() {
    return { x: 0, y: 0, z: 0 };
  }
};

export const Gyroscope = class Gyroscope {
  constructor() {
    this._freqMode = 1;
  }
  setFreqMode(m) {
    this._freqMode = m;
  }
  getFreqMode() {
    return this._freqMode;
  }
  onChange() {}
  offChange() {}
  start() {}
  stop() {}
  getCurrent() {
    return { x: 0, y: 0, z: 0 };
  }
};

export const checkSensor = () => true;

export const FREQ_MODE_LOW = 0;
export const FREQ_MODE_NORMAL = 1;
export const FREQ_MODE_HIGH = 2;

export const writeFileSync = () => {};
export const readFileSync = () => new ArrayBuffer(32);
export const openSync = () => 3;
export const writeSync = () => {};
export const closeSync = () => {};
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_APPEND = 4;
export const O_CREAT = 8;

export const log = { Logger: { getLogger: () => ({ log: () => {}, error: () => {} }) } };
export const px = (v) => v;
export const getDeviceInfo = () => ({ width: 480 });
