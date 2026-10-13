const login = document.querySelector("#login");
const error = document.querySelector("#error");

function fitWindow() {
  window.codexMonitor.fitCreditIntroduction(document.body.getBoundingClientRect().height + 2);
}

new ResizeObserver(fitWindow).observe(document.body);
document.fonts.ready.then(fitWindow);

login.addEventListener("click", async () => {
  login.disabled = true;
  error.hidden = true;
  try {
    await window.codexMonitor.beginCreditLogin();
  } catch {
    error.textContent = "Could not open OpenAI sign-in. Check your Codex login and try again.";
    error.hidden = false;
    login.disabled = false;
  }
});

document.querySelector("#later").addEventListener("click", () => window.codexMonitor.dismissCreditIntroduction());
document.addEventListener("keydown", event => {
  if (event.key === "Escape") window.codexMonitor.dismissCreditIntroduction();
});
