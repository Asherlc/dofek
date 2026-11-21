(() => {
  const root = document.getElementById("cycling-decoupling-preview");
  const get = (name) => root.querySelector(`[data-${name}]`);
  const now = Date.parse("2026-11-21T12:00:00Z");
  const day = 86400000;
  const formatDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const dateLabel = (date) => formatDate.format(date);
  const workout = "Endurance 60";
  const points = [
    { date: "2026-09-06", first: [181, 140, 100], second: [180, 148, 100] },
    { date: "2026-09-20", first: [181, 140, 100], second: [180, 146, 99] },
    { date: "2026-10-13", first: [180, 141, 100], second: [181, 147, 98] },
    { date: "2026-10-28", first: [179, 140, 99], second: [180, 144, 100] },
    { date: "2026-11-09", first: [180, 142, 100], second: [181, 145, 99] },
    { date: "2026-11-16", first: [182, 143, 99], second: [181, 146, 98] }
  ].map((point) => {
    const firstRatio = point.first[0] / point.first[1];
    const secondRatio = point.second[0] / point.second[1];
    return {
      ...point,
      time: Date.parse(`${point.date}T12:00:00Z`),
      percent: 100 * (firstRatio - secondRatio) / firstRatio
    };
  });
  const range = get("range");
  let current;

  function select(point) {
    current = point.date;
    for (const button of get("markers").children) {
      button.setAttribute("aria-pressed", String(button.dataset.date === current));
    }
    get("details").innerHTML = `
      <div class="ride-heading" data-dc-id="ride-heading">
        <div><h3>${workout} · ${dateLabel(point.time)}</h3>
        <p>60 min · Trainer + chest strap</p></div>
        <strong class="ride-reading" data-dc-id="decoupling-value">${point.percent.toFixed(1)}%</strong>
      </div>
      <dl class="samples">
        <div data-dc-id="first-half"><dt>First half</dt><dd>${point.first[0]} W · ${point.first[1]} bpm<span class="coverage">${point.first[2]}% paired coverage</span></dd></div>
        <div data-dc-id="second-half"><dt>Second half</dt><dd>${point.second[0]} W · ${point.second[1]} bpm<span class="coverage">${point.second[2]}% paired coverage</span></dd></div>
      </dl>`;
  }

  function render() {
    const start = now - (Number(range.value) - 1) * day;
    const rides = points.filter((point) => point.time >= start);
    const isEmpty = rides.length === 0;
    get("results").hidden = isEmpty;
    get("empty").hidden = !isEmpty;
    if (isEmpty) return;

    get("cohort").textContent = workout;
    get("count").textContent = `Same workout template · ${rides.length} ${rides.length === 1 ? "ride" : "rides"}`;
    get("ticks").replaceChildren(...[start, (start + now) / 2, now].map((time) => {
      const tick = document.createElement("span");
      tick.textContent = dateLabel(time);
      return tick;
    }));
    get("markers").replaceChildren(...rides.map((point) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ride-dot";
      button.dataset.date = point.date;
      button.dataset.dcId = "ride-" + point.date;
      button.style.left = `${100 * (point.time - start) / (now - start)}%`;
      button.style.top = `${100 * (8 - point.percent) / 12}%`;
      const label = `${workout}, ${dateLabel(point.time)}, ${point.percent.toFixed(1)}% decoupling`;
      button.setAttribute("aria-label", label);
      button.title = label;
      button.addEventListener("click", () => select(point));
      return button;
    }));
    select(rides.find((ride) => ride.date === current) ?? rides.at(-1));
  }

  range.addEventListener("change", render);
  render();
})();
