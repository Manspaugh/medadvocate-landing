// Optional: show a nice success message (works best with Formspree AJAX)
// If you keep plain HTML submit, this won't run (browser will navigate).
// To keep it simple + smooth, we intercept and submit via fetch.

const form = document.getElementById("waitlistForm");
const statusEl = document.getElementById("formStatus");

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "Submitting…";

    try {
      const formData = new FormData(form);
      const res = await fetch(form.action, {
        method: "POST",
        body: formData,
        headers: { "Accept": "application/json" }
      });

      if (res.ok) {
        form.reset();
        statusEl.textContent = "You’re on the list. 🎉";
      } else {
        statusEl.textContent = "Hmm—something went wrong. Try again.";
      }
    } catch {
      statusEl.textContent = "Network error. Please try again.";
    }
  });
}
