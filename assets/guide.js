// MedAdvocate guide shared behaviors — header scroll shadow + mobile nav
// drawer. Loaded on every /guides/ page. Page-specific JS stays inline.

// Header scroll shadow
(function () {
  var header = document.getElementById("site-header");
  function onScroll() {
    header.classList.toggle("scrolled", window.scrollY > 8);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();

// Mobile nav drawer
(function () {
  var toggle = document.getElementById("nav-toggle");
  var drawer = document.getElementById("nav-drawer");
  if (!toggle || !drawer) return;
  function setOpen(open) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    drawer.setAttribute("data-open", String(open));
    drawer.setAttribute("aria-hidden", String(!open));
  }
  toggle.addEventListener("click", function () {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });
  drawer.addEventListener("click", function (e) {
    if (e.target.tagName === "A") setOpen(false);
  });
})();
