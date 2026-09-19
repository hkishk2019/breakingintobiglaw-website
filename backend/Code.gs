/**
 * breakingintobiglaw.com — comment and update-notice collector.
 *
 * Paste into Extensions → Apps Script of a Google Sheet, then deploy as a
 * web app (Execute as: Me; Who has access: Anyone). See README.md.
 *
 * Writes two tabs, created on first use:
 *   Comments     — one row per highlight or comment
 *   Subscribers  — one row per email (repeat sign-ups update the row)
 */

// Optional: an address that gets an email for every new comment.
// Leave blank to rely on the Sheet alone.
var NOTIFY_EMAIL = '';

var COMMENT_HEADERS = ['Received', 'Name', 'Comment', 'Quoted passage', 'Page',
  'Document version', 'Note id', 'Reader id', 'Page URL', 'Highlight rects (JSON)'];
var SUBSCRIBER_HEADERS = ['First signed up', 'Email', 'Name', 'Source',
  'Document version', 'Reader id', 'Last signed up'];

var LIMITS = { name: 80, comment: 5000, quote: 2000, email: 200, short: 200, rects: 20000 };
var MAX_POSTS_PER_READER_PER_10_MIN = 30;

function doGet() {
  return json_({ ok: true, service: 'breakingintobiglaw' });
}

function doPost(e) {
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // Honeypot: real readers never fill the hidden "website" field.
    if (data.website) return json_({ ok: true });

    if (!allowReader_(data.clientId)) {
      return json_({ ok: false, error: 'rate-limited' });
    }

    if (data.type === 'comment') return saveComment_(data);
    if (data.type === 'subscribe') return saveSubscriber_(data);
    return json_({ ok: false, error: 'unknown-type' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function saveComment_(d) {
  var comment = clip_(d.comment, LIMITS.comment);
  var quote = clip_(d.quote, LIMITS.quote);
  if (!comment && !quote) return json_({ ok: false, error: 'empty' });

  var name = clip_(d.name, LIMITS.name);
  var page = Number(d.page) > 0 ? Number(d.page) : '';
  var rects = '';
  try { rects = clip_(JSON.stringify(d.rects || []), LIMITS.rects); } catch (ignored) {}

  var row = [new Date(), name, comment, quote, page,
    clip_(d.docVersion, LIMITS.short), clip_(d.noteId, LIMITS.short),
    clip_(d.clientId, LIMITS.short), clip_(d.pageUrl, LIMITS.short), rects];

  withLock_(function () {
    sheet_('Comments', COMMENT_HEADERS).appendRow(row.map(safeCell_));
  });

  if (NOTIFY_EMAIL) {
    try {
      MailApp.sendEmail(NOTIFY_EMAIL,
        'New comment on breakingintobiglaw.com' + (page ? ' (p. ' + page + ')' : ''),
        (name || 'Anonymous') + ' wrote:\n\n' + (comment || '(highlight only)') +
        (quote ? '\n\nOn the passage:\n“' + quote + '”' : '') +
        '\n\nDocument version: ' + (d.docVersion || ''));
    } catch (ignored) {
      // The row is saved; a mail quota error must not fail the reader's request.
    }
  }
  return json_({ ok: true });
}

function saveSubscriber_(d) {
  var email = clip_(d.email, LIMITS.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json_({ ok: false, error: 'invalid-email' });
  }
  withLock_(function () {
    var sheet = sheet_('Subscribers', SUBSCRIBER_HEADERS);
    var last = sheet.getLastRow();
    if (last > 1) {
      var emails = sheet.getRange(2, 2, last - 1, 1).getValues();
      for (var i = 0; i < emails.length; i++) {
        if (String(emails[i][0]).toLowerCase() === email) {
          sheet.getRange(i + 2, 7).setValue(new Date());
          return;
        }
      }
    }
    sheet.appendRow([new Date(), email, clip_(d.name, LIMITS.name),
      clip_(d.source, LIMITS.short), clip_(d.docVersion, LIMITS.short),
      clip_(d.clientId, LIMITS.short), new Date()].map(safeCell_));
  });
  return json_({ ok: true });
}

// ---------------------------------------------------------------- helpers

function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { fn(); } finally { lock.releaseLock(); }
}

function allowReader_(clientId) {
  var id = clip_(clientId, 100);
  if (!id) return true;
  var cache = CacheService.getScriptCache();
  var key = 'rate_' + id;
  var count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), 600);
  return count <= MAX_POSTS_PER_READER_PER_10_MIN;
}

function clip_(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

// Text starting with = + - @ would run as a formula in the Sheet.
function safeCell_(value) {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) return "'" + value;
  return value;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
