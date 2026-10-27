// ============================================================
// USER GUIDE (Settings > Help)
//
// Opens docs/ELG-FMS-User-Guide.pdf in the same PDF popup the
// Annex uses for brochures, without the Download button.
// To update the guide, replace the PDF file; nothing else.
// ============================================================

import { openPdf } from "./annex.js";

const GUIDE_FILE = "docs/ELG-FMS-User-Guide.pdf";

function openUserGuide() {
    const version = document.getElementById("app-version")?.textContent.trim() || "";
    const absolute = new URL(GUIDE_FILE, window.location.href).href;

    openPdf(absolute, GUIDE_FILE, "ELG FMS User Guide", version ? `User guide · ${version}` : "User guide", { download: false });
}

function initializeUserGuide() {
    document.querySelectorAll("[data-user-guide-open]").forEach(button => {
        button.addEventListener("click", openUserGuide);
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeUserGuide);
} else {
    initializeUserGuide();
}
