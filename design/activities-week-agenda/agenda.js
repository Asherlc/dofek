const openRange = document.querySelector('[data-dc-id="date-range"]');
const rangeDialog = document.querySelector("#range-dialog");
const rangeForm = rangeDialog.querySelector("form");
const startField = rangeForm.elements.namedItem("startDate");
const endField = rangeForm.elements.namedItem("endDate");
const days = Array.from(document.querySelectorAll(".week > .day"), (element) => ({
  element,
  date: element.querySelector("time").dateTime,
}));
const empty = document.querySelector(".range-empty");
const rangeStatus = document.querySelector("[data-range-status]");
const dateLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
let selectedStart = startField.value;
let selectedEnd = endField.value;

function applyRange(start, end) {
  selectedStart = start;
  selectedEnd = end;
  const label = dateLabel.formatRange(new Date(start), new Date(end));
  openRange.textContent = label;
  openRange.setAttribute("aria-label", `Date range, ${label}`);

  let visible = 0;
  for (const { element, date } of days) {
    element.hidden = date < start || date > end;
    if (!element.hidden) visible += 1;
  }
  empty.hidden = visible > 0;
  rangeStatus.textContent = visible === 0
    ? `${label}. No workouts in this date range.`
    : `Showing ${label}.`;
  rangeDialog.close();
}

openRange.addEventListener("click", () => {
  startField.value = selectedStart;
  endField.value = selectedEnd;
  endField.setCustomValidity("");
  rangeDialog.showModal();
});

rangeForm.addEventListener("input", () => endField.setCustomValidity(""));
rangeForm.querySelector('[data-dc-id="cancel-range"]').addEventListener("click", () => {
  rangeDialog.close();
});
rangeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (endField.value < startField.value) {
    endField.setCustomValidity("Choose an end date on or after the start date.");
    endField.reportValidity();
    return;
  }
  applyRange(startField.value, endField.value);
});

for (const preset of rangeForm.querySelectorAll("[data-start]")) {
  preset.addEventListener("click", () => applyRange(preset.dataset.start, preset.dataset.end));
}
