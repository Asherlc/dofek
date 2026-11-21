const host = document.querySelector('[data-durability]');

host.innerHTML = `
  <div class="durability-heading">
    <h2 id="durability-heading" class="section-title" data-dc-id="durability-heading">Cycling Durability</h2>
    <p class="muted" data-context>Outdoor rides · Sample data</p>
  </div>
  <div class="durability-controls">
    <label>Effort duration
      <select data-dc-id="effort-duration" data-duration>
        <option value="0">10 seconds</option>
        <option value="1">1 minute</option>
        <option value="2" selected>5 minutes</option>
        <option value="3">20 minutes</option>
      </select>
    </label>
    <label>Minimum prior work
      <select data-dc-id="minimum-work" data-work>
        <option value="10">10 kJ/kg</option>
        <option value="20">20 kJ/kg</option>
        <option value="30" selected>30 kJ/kg</option>
        <option value="40">40 kJ/kg</option>
        <option value="50">50 kJ/kg</option>
      </select>
    </label>
  </div>
  <div class="durability-layout" aria-live="polite" aria-atomic="true">
    <div class="durability-result" data-dc-id="comparison-result">
      <strong data-result></strong>
      <span class="muted" data-caption></span>
    </div>
    <div class="durability-bars">
      <div class="bar-row" data-dc-id="reference-bar">
        <span>Unrestricted best</span><b data-reference-value></b>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill reference"></div></div>
      </div>
      <div class="bar-row" data-dc-id="post-work-bar" data-late-row>
        <span data-threshold></span><b data-late-value></b>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill" data-fill></div></div>
      </div>
    </div>
  </div>
  <details class="evidence" data-dc-id="effort-evidence">
    <summary>Effort evidence</summary>
    <div class="evidence-grid">
      <div><h3>Unrestricted best</h3><p data-reference-ride></p><p data-reference-work></p></div>
      <div data-late-detail><h3>After prior work</h3><p data-late-ride></p><p data-late-work></p></div>
    </div>
    <p class="evidence-source">Strava · Meter power · 1-second samples · Complete coverage through effort end</p>
    <p class="evidence-source">Weight source · 72.0 kg scale reading on each ride date</p>
  </details>`;

const durations = ['10-second', '1-minute', '5-minute', '20-minute'];
const samples = [
  { ride: 'Hill repeats', day: 3, watts: [815, 472, 320, 267], work: [42, 89, 190, 269], offset: ['04:26', '08:55', '18:42', '26:15'] },
  { ride: 'Canal loop', day: 10, watts: [768, 455, 314, 261], work: 752, offset: '1:08:09' },
  { ride: 'Windy ridge ride', day: 14, watts: [722, 432, 306, 254], work: 1527, offset: '2:11:34' },
  { ride: 'Saturday endurance ride', day: 7, watts: [681, 417, 296, 243], work: 2246, offset: '3:22:16' },
  { ride: 'Long valley loop', day: 15, watts: [627, 390, 281, 231], work: 2932, offset: '4:19:42' },
];
const weightKg = 72;
const endDate = Date.UTC(2026, 10, 15);
const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const get = name => host.querySelector(`[data-${name}]`);
const write = (name, content) => { get(name).textContent = content; };
const displayPower = watts => `${watts} W · ${(watts / weightKg).toFixed(2)} W/kg`;

function showEvidence(prefix, effort) {
  write(`${prefix}-ride`, `${effort.ride} · Nov ${effort.day} · ${effort.offset} into ride`);
  write(`${prefix}-work`, `${effort.work.toLocaleString('en-US')} kJ before effort · ${(effort.work / weightKg).toFixed(1)} kJ/kg`);
}

function render() {
  const range = document.querySelector('[name="range"]:checked');
  const days = Number(range.value);
  const firstDay = 16 - days;
  const start = Number.isFinite(days) ? dateLabel.format(endDate - (days - 1) * 86_400_000) : 'All dates';
  const duration = Number(get('duration').value);
  const threshold = Number(get('work').value);
  const activities = samples.filter(sample => sample.day >= firstDay);
  const efforts = activities.map(sample => ({
    ...sample,
    watts: sample.watts[duration],
    work: Array.isArray(sample.work) ? sample.work[duration] : sample.work,
    offset: Array.isArray(sample.offset) ? sample.offset[duration] : sample.offset,
  })).sort((left, right) => right.watts - left.watts);
  const best = efforts[0];
  const late = efforts.find(effort => effort.work / weightKg >= threshold);
  const displayedRange = days === Infinity ? start : `${start}–Nov 15`;
  write('context', `Outdoor rides · ${displayedRange} · Sample data`);
  write('reference-value', displayPower(best.watts));
  showEvidence('reference', best);
  get('late-row').hidden = late == null;
  get('late-detail').hidden = late == null;
  if (late) {
    const ratio = late.watts / best.watts;
    write('result', ratio === 1 ? 'Same as unrestricted best' : `${((1 - ratio) * 100).toFixed(1)}% lower`);
    write('caption', `${durations[duration]} power after ${threshold} kJ/kg`);
    write('threshold', `After at least ${threshold} kJ/kg`);
    write('late-value', displayPower(late.watts));
    get('fill').style.width = `${ratio * 100}%`;
    showEvidence('late', late);
  } else {
    write('result', 'Comparison unavailable');
    write('caption', `No eligible ${durations[duration]} effort after ${threshold} kJ/kg`);
  }

  const recentValues = durations.map((_, index) => Math.max(...activities.map(activity => activity.watts[index])));
  document.querySelectorAll('[data-recent-value]').forEach((cell, index) => {
    cell.textContent = `${recentValues[index]} W`;
  });
  const curve = document.querySelector('[data-recent-curve]');
  if (curve) {
    const positions = [70, 188, 330, 452];
    const points = recentValues.map((watts, index) => `${positions[index]},${117 - watts * .115}`);
    curve.setAttribute('points', points.join(' '));
    document.querySelector('[data-recent-label]').textContent = range.parentElement.textContent.trim();
  }
}

host.addEventListener('change', render);
document.querySelector('.range').addEventListener('change', render);
render();
