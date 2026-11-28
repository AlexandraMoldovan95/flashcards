// Tests for logic.js: the scheduler (simplified SM-2), due cards, hints, answer comparison,
// card validation, escaping, category colors and stats. No browser needed.
// Run:  node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../logic.js");

// Noon UTC, so the date is the same in UTC and in Romania (the app formats dates in UTC).
const DAY = (iso) => new Date(iso + "T12:00:00Z");
const freshCard = (extra = {}) => L.normalizeCard({ question: "Q", answer: "A", ...extra });

// ---------- scheduler ----------

test("a new card graded Easy comes back in 2 days, ease goes up", () => {
  const c = L.evaluateCard(freshCard(), "easy", DAY("2026-03-10"));
  assert.equal(c.interval, 2);
  assert.equal(c.repetitionCount, 1);
  assert.equal(c.easeFactor, 2.65);
  assert.equal(c.easyCount, 1);
  assert.equal(c.lastReviewed, "2026-03-10");
  assert.equal(c.nextReviewDate, "2026-03-12");
});

test("a new card graded Ok comes back tomorrow, ease drops slightly", () => {
  const c = L.evaluateCard(freshCard(), "ok", DAY("2026-03-10"));
  assert.equal(c.interval, 1);
  assert.equal(c.easeFactor, 2.48);
  assert.equal(c.okCount, 1);
  assert.equal(c.nextReviewDate, "2026-03-11");
});

test("Hard resets the streak and brings the card back tomorrow", () => {
  const c = freshCard({ repetitionCount: 4, interval: 20, easeFactor: 2.5 });
  L.evaluateCard(c, "hard", DAY("2026-03-10"));
  assert.equal(c.repetitionCount, 0);
  assert.equal(c.interval, 1);
  assert.equal(c.easeFactor, 2.3);
  assert.equal(c.hardCount, 1);
  assert.equal(c.nextReviewDate, "2026-03-11");
});

test("second review: Ok = 3 days, Easy = 4 days", () => {
  const ok = freshCard({ repetitionCount: 1, interval: 1 });
  const easy = freshCard({ repetitionCount: 1, interval: 1 });
  assert.equal(L.evaluateCard(ok, "ok", DAY("2026-03-10")).interval, 3);
  assert.equal(L.evaluateCard(easy, "easy", DAY("2026-03-10")).interval, 4);
});

test("later reviews multiply the interval by the ease, Easy adds a 1.3x bonus", () => {
  const ok = freshCard({ repetitionCount: 2, interval: 10, easeFactor: 2.5 });
  L.evaluateCard(ok, "ok", DAY("2026-03-10"));
  assert.equal(ok.easeFactor, 2.48);
  assert.equal(ok.interval, Math.round(10 * 2.48));          // 25
  const easy = freshCard({ repetitionCount: 2, interval: 10, easeFactor: 2.5 });
  L.evaluateCard(easy, "easy", DAY("2026-03-10"));
  assert.equal(easy.interval, Math.round(Math.round(10 * 2.65) * 1.3)); // 27 -> 35
});

test("ease never goes below 1.3 or above 3.0", () => {
  const hard = freshCard();
  for (let i = 0; i < 20; i++) L.evaluateCard(hard, "hard", DAY("2026-03-10"));
  assert.equal(hard.easeFactor, 1.3);
  const easy = freshCard();
  for (let i = 0; i < 20; i++) L.evaluateCard(easy, "easy", DAY("2026-03-10"));
  assert.equal(easy.easeFactor, 3.0);
});

test("the interval is capped at 365 days, so many Easy grades in a row never crash", () => {
  // Before the cap, the 15th Easy pushed the date past JavaScript's limit ("Invalid time value").
  const c = freshCard();
  for (let i = 0; i < 50; i++) L.evaluateCard(c, "easy", DAY("2026-03-10"));
  assert.equal(c.interval, 365);
  assert.equal(c.nextReviewDate, "2027-03-10");
});

test("next review date crosses month and year ends correctly", () => {
  const c = freshCard({ repetitionCount: 1, interval: 1 });
  assert.equal(L.evaluateCard(c, "ok", DAY("2026-01-30")).nextReviewDate, "2026-02-02");
  const d = freshCard({ repetitionCount: 1, interval: 1 });
  assert.equal(L.evaluateCard(d, "easy", DAY("2026-12-30")).nextReviewDate, "2027-01-03");
});

test("due cards: today and earlier are due, later ones are not", () => {
  const cards = [freshCard({ nextReviewDate: "2026-03-09" }), freshCard({ nextReviewDate: "2026-03-10" }),
                 freshCard({ nextReviewDate: "2026-03-11" })];
  assert.deepEqual(L.getDueCards(cards, "2026-03-10").map((c) => c.nextReviewDate), ["2026-03-09", "2026-03-10"]);
});

// ---------- hints: never the full answer ----------

test("hint level 1 shows the first letter and the length", () => {
  assert.equal(L.buildHintForLevel("Paris", 1), "P____  (5 letters)");
  assert.equal(L.buildHintForLevel("A", 1), "_  (1 letter)");
});

test("hint level 3 hides the last word, or the last 3 letters of a single word", () => {
  assert.equal(L.buildHintForLevel("Not Found", 3), "Not _____");
  assert.equal(L.buildHintForLevel("Bucharest", 3), "Buchar___");
});

test("no hint level reveals the whole answer, even for short answers", () => {
  for (const answer of ["Paris", "Not Found", "Hi", "42", "A", "OK!", "Internal Server Error"]) {
    for (const level of [1, 2, 3]) {
      const hint = L.buildHintForLevel(answer, level).replace(/\s+\(\d+ letters?\)$/, "");
      assert.notEqual(hint, answer, `level ${level} of "${answer}" gave "${hint}"`);
    }
  }
});

test("hints are deterministic (same card, same hint)", () => {
  assert.equal(L.buildHintForLevel("Regression test", 2), L.buildHintForLevel("Regression test", 2));
});

// ---------- typed-answer comparison ----------

test("answer comparison ignores case, accents, extra spaces and trailing punctuation", () => {
  const n = L.normalizeAnswerForCompare;
  assert.equal(n("  Orașul   Brașov. "), n("orasul brasov"));
  assert.equal(n("Paris!"), n("paris"));
  assert.notEqual(n("Paris"), n("The city of Paris"));   // a hint, not a semantic judgment
});

// ---------- card validation (imported decks come from other people) ----------

test("a card with missing fields gets safe defaults", () => {
  const c = L.normalizeCard({ question: "Q", answer: "A" });
  assert.equal(c.category, "General");
  assert.deepEqual(c.tags, []);
  assert.equal(c.image, null);
  assert.equal(c.interval, 1);
  assert.equal(c.easeFactor, 2.5);
  assert.match(c.nextReviewDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(c.id);
});

test("tags are trimmed and de-duplicated", () => {
  assert.deepEqual(L.normalizeCard({ tags: [" qa ", "qa", "", "web"] }).tags, ["qa", "web"]);
  assert.deepEqual(L.parseTagsInput("qa, web ,qa,,"), ["qa", "web"]);
});

test("a fake image or a non-date is dropped", () => {
  const c = L.normalizeCard({ image: 'data:image/png" onerror="alert(1)', nextReviewDate: "<img src=x>", lastReviewed: "yesterday" });
  assert.equal(c.image, null);
  assert.match(c.nextReviewDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(c.lastReviewed, null);
  const real = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  assert.equal(L.normalizeCard({ image: real }).image, real);
});

test("escapeHtml is safe inside attributes too", () => {
  assert.equal(L.escapeHtml(`<b>"x" & 'y'</b>`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
  assert.equal(L.escapeHtml(null), "");
});

// ---------- categories and stats ----------

test("a category always gets the same color, whatever the case", () => {
  const key = L.getCategoryColorKey("Software testing");
  assert.ok(L.CATEGORY_PALETTE_KEYS.includes(key));
  assert.equal(L.getCategoryColorKey("SOFTWARE TESTING "), key);
  assert.equal(L.getCategoryColorKey(""), L.getCategoryColorKey("General"));
});

test("category stats: success rate, best first, unreviewed categories left out", () => {
  const cards = [
    freshCard({ category: "Web", hardCount: 1, okCount: 1, easyCount: 0 }),
    freshCard({ category: "QA", hardCount: 0, okCount: 2, easyCount: 2 }),
    freshCard({ category: "New" }),
  ];
  const stats = L.computeCategoryStats(cards);
  assert.deepEqual(stats.map((s) => [s.category, s.successRate, s.total]), [["QA", 1, 4], ["Web", 0.5, 2]]);
});

test("back to top: hidden on a page shorter than two screens (few cards), however far it's scrolled", () => {
  assert.equal(L.shouldShowToTop(0, 900, 900), false);
  assert.equal(L.shouldShowToTop(700, 900, 1600), false);
  assert.equal(L.shouldShowToTop(899, 900, 1799), false);
});

test("back to top: on a long page (many cards), only after half a screen of scrolling", () => {
  assert.equal(L.shouldShowToTop(0, 900, 5000), false);
  assert.equal(L.shouldShowToTop(449, 900, 5000), false);
  assert.equal(L.shouldShowToTop(450, 900, 5000), true);
  assert.equal(L.shouldShowToTop(422, 844, 1688), true);   // exactly two phone screens
});
