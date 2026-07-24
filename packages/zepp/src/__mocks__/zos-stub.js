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

export const HeartRate = class HeartRate {
  getToday() {
    return [];
  }
  getResting() {
    return 65;
  }
  getDailySummary() {
    return {};
  }
  getLast() {
    return 72;
  }
};

export const Step = class Step {
  getCurrent() {
    return 0;
  }
  getTarget() {
    return 10000;
  }
};

export const Distance = class Distance {
  getCurrent() {
    return 0;
  }
};

export const Sleep = class Sleep {
  updateInfo() {}
  getInfo() {
    return { score: 0, deepTime: 0, startTime: 0, endTime: 0, totalTime: 0 };
  }
  getStage() {
    return [];
  }
  getNap() {
    return [];
  }
};

export const BloodOxygen = class BloodOxygen {
  getCurrent() {
    return { value: 0 };
  }
  getLastDay() {
    return [];
  }
  getLastFewHour() {
    return [];
  }
};

export const BodyTemperature = class BodyTemperature {
  getCurrent() {
    return { current: 0 };
  }
  getToday() {
    return [];
  }
};

export const Stress = class Stress {
  getToday() {
    return [];
  }
  getTodayByHour() {
    return [];
  }
  getLastWeek() {
    return [];
  }
};

export const Stand = class Stand {
  getCurrent() {
    return 0;
  }
};

export const Pai = class Pai {
  getCurrent() {
    return 0;
  }
};

export const FatBurning = class FatBurning {
  getCurrent() {
    return 0;
  }
};

export const checkSensor = () => true;

export const writeFileSync = () => {};
export const readFileSync = () => new ArrayBuffer(32);
export const openSync = () => 3;
export const writeSync = () => {};
export const closeSync = () => {};
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_APPEND = 4;
export const O_CREAT = 8;

export const log = { getLogger: () => ({ log: () => {}, error: () => {} }) };
export const px = (v) => v;
export const getDeviceInfo = () => ({ width: 480, height: 480 });
