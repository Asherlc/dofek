const host = document.querySelector('[data-durability]');
const standalone = host.dataset.durability === 'standalone';
const weightKg = 72;
const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const amount = kilojoules => `${kilojoules.toLocaleString('en-US')} kJ`;
const workLevels = [10, 20, 30, 40, 50];

host.innerHTML = `
  <div class="durability-heading">
    <h2 id="${standalone ? 'durability-title' : 'durability-heading'}" class="section-title" data-dc-id="${standalone ? 'title' : 'durability-heading'}">Power after sustained riding</h2>
    <p class="muted" data-context></p>
  </div>
  <p class="durability-intro">Both numbers are your best power for the same effort length. The second counts only efforts that start after a set amount of pedaling in that ride.</p>
  <div class="durability-layout" aria-live="polite" aria-atomic="true">
    <div class="durability-result" data-dc-id="${standalone ? 'result' : 'comparison-result'}">
      <strong data-result></strong>
      <span class="muted" data-caption></span>
    </div>
    <div class="durability-bars">
      <div class="bar-row" data-dc-id="${standalone ? 'unrestricted-best' : 'reference-bar'}">
        <span>Best at any point in a ride</span><b data-reference-value></b>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill reference"></div></div>
      </div>
      <div class="bar-row" data-dc-id="${standalone ? 'after-prior-work' : 'post-work-bar'}" data-late-row>
        <span data-threshold></span><b data-late-value></b>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill" data-fill></div></div>
      </div>
    </div>
  </div>
  <p class="evidence-source" id="work-help">Kilojoules (kJ) measure work at the pedals. Harder pedaling adds them faster.</p>
  <details class="durability-disclosure" data-dc-id="comparison-settings">
    <summary>Change comparison</summary>
    <div class="durability-controls">
      <label>Effort length
        <select data-dc-id="effort-duration" data-duration>
          <option value="0">10 seconds</option>
          <option value="1">1 minute</option>
          <option value="2" selected>5 minutes</option>
          <option value="3">20 minutes</option>
        </select>
      </label>
      <label>Pedaling before the effort
        <select data-dc-id="${standalone ? 'work-threshold' : 'minimum-work'}" data-work aria-describedby="work-help">
          ${workLevels.map(level => `<option value="${level}"${level === 30 ? ' selected' : ''}>At least ${amount(level * weightKg)}</option>`).join('')}
        </select>
      </label>
    </div>
  </details>
  <details class="durability-disclosure"${standalone ? '' : ' data-dc-id="effort-evidence"'}>
    <summary${standalone ? ' data-dc-id="effort-evidence"' : ''}>See the rides behind these numbers</summary>
    <div class="evidence-grid"${standalone ? ' data-dc-id="effort-details"' : ''}>
      <div><h3>Best at any point</h3><p data-reference-ride></p><p data-reference-work></p></div>
      <div data-late-detail><h3>Best after extra pedaling</h3><p data-late-ride></p><p data-late-work></p></div>
    </div>
    <p class="evidence-source">This example compares outdoor rides so both efforts come from the same riding setting.</p>
    <p class="evidence-source" data-cutoff></p>
    <p class="evidence-source">Power meter data from Strava · One reading per second · Complete data from ride start through each effort</p>
  </details>`;

const durations = ['10-second', '1-minute', '5-minute', '20-minute'];
const samples = [
  { ride: 'Hill repeats', day: 3, watts: [815, 472, 320, 267], work: [42, 89, 190, 269], offset: ['04:26', '08:55', '18:42', '26:15'] },
  { ride: 'Canal loop', day: 10, watts: [768, 455, 314, 261], work: 752, offset: '1:08:09' },
  { ride: 'Windy ridge ride', day: 14, watts: [722, 432, 306, 254], work: 1527, offset: '2:11:34' },
  { ride: 'Saturday endurance ride', day: 7, watts: [681, 417, 296, 243], work: 2246, offset: '3:22:16' },
  { ride: 'Long valley loop', day: 15, watts: [627, 390, 281, 231], work: 2932, offset: '4:19:42' },
];
const endDate = Date.UTC(2026, 10, 15);
const get = name => host.querySelector(`[data-${name}]`);
const write = (name, content) => { get(name).textContent = content; };

function showEvidence(prefix, effort) {
  write(`${prefix}-ride`, `${effort.ride} · Nov ${effort.day} · ${effort.offset} into ride`);
  write(`${prefix}-work`, `${amount(effort.work)} of pedaling before the effort`);
}

function render() {
  const range = document.querySelector('[name="range"]:checked');
  const days = range ? Number(range.value) : 28;
  const firstDay = 16 - days;
  const start = Number.isFinite(days) ? dateLabel.format(endDate - (days - 1) * 86_400_000) : 'All dates';
  const duration = Number(get('duration').value);
  const threshold = Number(get('work').value);
  const thresholdAmount = amount(threshold * weightKg);
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
  write('context', `${displayedRange} · Sample data`);
  write('reference-value', `${best.watts} W`);
  write('cutoff', `The work cutoff scales with body weight. At the sample rider’s measured ${weightKg} kg, ${thresholdAmount} equals ${threshold} kJ/kg.`);
  showEvidence('reference', best);
  get('late-row').hidden = late == null;
  get('late-detail').hidden = late == null;
  if (late) {
    const difference = best.watts - late.watts;
    write('result', difference === 0 ? 'Same power' : `${difference} W lower`);
    write('caption', `Best ${durations[duration]} power after at least ${thresholdAmount} of pedaling`);
    write('threshold', `Best after at least ${thresholdAmount}`);
    write('late-value', `${late.watts} W`);
    get('fill').style.width = `${late.watts / best.watts * 100}%`;
    showEvidence('late', late);
  } else {
    write('result', 'No matching effort');
    write('caption', `No ${durations[duration]} effort was recorded after at least ${thresholdAmount} of pedaling.`);
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
document.querySelector('.range')?.addEventListener('change', render);
render();
