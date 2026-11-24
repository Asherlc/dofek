const rangeControl = document.querySelector('[data-dc-id="date-range"]');
const caption = document.querySelector(".range-caption");
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

function applyRange({ dataset: { start, end } }) {
  const label = dateLabel.formatRange(new Date(start), new Date(end));
  caption.textContent = label;

  for (const { element, date } of days) {
    element.hidden = date < start || date > end;
  }
  empty.hidden = days.some(({ element }) => !element.hidden);
  rangeStatus.textContent = empty.hidden ? `Showing ${label}.` : `${label}. No workouts in this date range.`;
}

if (rangeControl instanceof HTMLSelectElement) {
  rangeControl.addEventListener("change", () => applyRange(rangeControl.selectedOptions[0]));
} else {
  const options = document.querySelector("#range-options");
  const choices = options.querySelectorAll("button");

  rangeControl.addEventListener("click", () => {
    options.hidden = !options.hidden;
    rangeControl.setAttribute("aria-expanded", String(!options.hidden));
  });

  for (const choice of choices) {
    choice.addEventListener("click", () => {
      applyRange(choice);
      for (const option of choices) {
        option.setAttribute("aria-pressed", String(option === choice));
      }
      rangeControl.textContent = choice.textContent;
      rangeControl.setAttribute("aria-label", `Date range, ${choice.textContent}`);
      rangeControl.setAttribute("aria-expanded", "false");
      options.hidden = true;
      rangeControl.focus();
    });
  }
}
