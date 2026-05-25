interface PmcEwmaCalculatorOptions {
  chronicTrainingLoadDays: number;
  acuteTrainingLoadDays: number;
}

interface PmcEwmaInput {
  dailyLoad: Map<string, number>;
  queryDays: number;
  displayDays: number;
}

interface PmcDataPoint {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
}

export class PmcEwmaCalculator {
  readonly #chronicTrainingLoadDays: number;
  readonly #acuteTrainingLoadDays: number;

  constructor(options: PmcEwmaCalculatorOptions) {
    this.#chronicTrainingLoadDays = options.chronicTrainingLoadDays;
    this.#acuteTrainingLoadDays = options.acuteTrainingLoadDays;
  }

  compute(input: PmcEwmaInput): PmcDataPoint[] {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - input.queryDays);
    const endDate = new Date();

    const result: PmcDataPoint[] = [];
    let chronicTrainingLoad = 0;
    let acuteTrainingLoad = 0;

    const current = new Date(startDate);
    const warmUpDays = input.queryDays - input.displayDays;
    let dayIndex = 0;

    while (current <= endDate) {
      const dateStr = current.toISOString().slice(0, 10);
      const load = input.dailyLoad.get(dateStr) ?? 0;

      chronicTrainingLoad =
        chronicTrainingLoad + (load - chronicTrainingLoad) / this.#chronicTrainingLoadDays;
      acuteTrainingLoad =
        acuteTrainingLoad + (load - acuteTrainingLoad) / this.#acuteTrainingLoadDays;
      const trainingStressBalance = chronicTrainingLoad - acuteTrainingLoad;

      if (dayIndex >= warmUpDays) {
        result.push({
          date: dateStr,
          load: Math.round(load * 10) / 10,
          ctl: Math.round(chronicTrainingLoad * 10) / 10,
          atl: Math.round(acuteTrainingLoad * 10) / 10,
          tsb: Math.round(trainingStressBalance * 10) / 10,
        });
      }

      dayIndex++;
      current.setDate(current.getDate() + 1);
    }

    let firstMeaningfulIndex = result.findIndex((dataPoint) => dataPoint.ctl >= 0.1);
    if (firstMeaningfulIndex < 0) firstMeaningfulIndex = 0;
    return result.slice(firstMeaningfulIndex);
  }
}
