const gradeButtons = document.querySelectorAll("button[data-evidence]");

for (const selectedButton of gradeButtons) {
  selectedButton.addEventListener("click", () => {
    const wasOpen = selectedButton.getAttribute("aria-expanded") === "true";

    for (const button of gradeButtons) {
      const open = button === selectedButton && !wasOpen;
      button.setAttribute("aria-expanded", String(open));
      document.getElementById(button.getAttribute("aria-controls")).hidden = !open;
    }
  });
}
