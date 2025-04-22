import { createDesign1 } from "./design1.js";
import { createDesign2 } from "./design2.js";

async function renderDesign(design) {
  document.body.classList.remove("design1", "design2");
  document.body.classList.add(design);

  const appEl = document.getElementById("app");
  // Clear only the #app content. The toggle button stays outside in the HTML.
  appEl.innerHTML = "";

  let designEl;
  if (design === "design1") {
    designEl = await createDesign1();
  } else {
    designEl = await createDesign2();
  }

  appEl.appendChild(designEl);
  localStorage.setItem("designPreference", design);
}

document.addEventListener("DOMContentLoaded", async () => {
  const userPref = localStorage.getItem("designPreference") || "design1";
  await renderDesign(userPref);

  const toggleBtn = document.getElementById("toggle-design-btn");
  toggleBtn.addEventListener("click", async () => {
    const current = localStorage.getItem("designPreference") || "design1";
    const newDesign = current === "design1" ? "design2" : "design1";
    await renderDesign(newDesign);
  });
});
