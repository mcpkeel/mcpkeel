// Copy buttons. The label says what happened and then returns to the action.
for (const button of document.querySelectorAll("button.copy")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy the command";
    }
    setTimeout(() => (button.textContent = "Copy"), 2000);
  });
}
