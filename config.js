// Site settings. Edit this file; nothing else needs to change for a new
// document or a new backend URL.
window.BIBL_CONFIG = {
  // Google Apps Script web-app URL (see backend/README.md). Leave blank until
  // the backend is deployed; on localhost the dev server's /api/submit is used.
  endpoint: "https://script.google.com/macros/s/AKfycbwvAX9xvT_7GkvtdIXMwNKWfeay0C7-VSh65jIGb1seeUOsTepf1uMmNU08koeX-96qMQ/exec",

  // The document readers see. Replace guide.pdf to publish a new version, and
  // bump documentVersion so comments record which version they were made on.
  documentUrl: "guide.pdf",
  documentVersion: "2026-09-18 v3 draft",

  // The reading edition at /read.html is generated from the guide source and moves
  // on its own; comments made there are recorded under this label instead.
  readVersion: "2026-11-09 reading edition",

  // Shown in the update dialog: "We expect to update the guide again by ___."
  updateBy: "the end of September 2026",

  // Seconds of visible reading time before the update dialog appears.
  popupDelaySeconds: 30,

  // After "Not now", wait this many days before asking the same reader again.
  popupSnoozeDays: 7,
};
