// Flashcards: the pure logic (no DOM, no localStorage), shared by the page and the tests.
// Loaded with a plain <script> before app.js, so its functions are globals there;
// in Node (tests/logic.test.js) the same file is loaded with require().

  // Marker-highlighter palette — 7 distinct colors. The keys below map
  // directly to the CSS variables --cat-<key>-vivid / -soft.
  const CATEGORY_PALETTE_KEYS = ["sunflower", "corai", "menta", "cer", "magenta", "liliac", "turcoaz"];

  // DETERMINISTIC assignment: the same category always gets the same
  // color, on every re-render — it isn't stored per card, it's computed
  // at render time from a stable hash of the name (sum of character
  // codes, case-insensitive, mod the palette size).
  function getCategoryColorKey(categoryName) {
    const name = String(categoryName || "General").trim().toLowerCase();
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash + name.charCodeAt(i)) % CATEGORY_PALETTE_KEYS.length;
    }
    return CATEGORY_PALETTE_KEYS[hash];
  }

  // Hangman-style hint mask: letters/digits → "_", everything else
  // (spaces, punctuation) stays visible so the word structure is kept.
  function maskChar(ch) {
    return /[a-zA-Z\u00e0\u00e2\u00e4\u00e9\u00e8\u00ea\u00eb\u00ef\u00ee\u00f4\u00f6\u00f9\u00fb\u00fc\u00ff\u00f1\u00e7\u0103\u00e2\u00ee\u0219\u021b\u0102\u00c2\u00ce\u0218\u021a0-9]/.test(ch) ? "_" : ch;
  }

  // Very short answers ("A", "Hi") came out fully visible at levels 1-2 (found by the tests):
  // if nothing is hidden yet, hide the last letter/digit, so the rule below still holds.
  function hideLastLetterIfNothingHidden(hint, answer) {
    if (hint !== answer) return hint;
    const chars = hint.split("");
    for (let i = chars.length - 1; i >= 0; i--) {
      if (maskChar(chars[i]) === "_") { chars[i] = "_"; break; }
    }
    return chars.join("");
  }

  // Builds the hint text for a given level, derived STRICTLY from
  // card.answer — no level ever reveals text 100% identical to the
  // full answer.
  function buildHintForLevel(answer, level) {
    const letterCount = answer.replace(/[^a-zA-ZàâäéèêëïîôöùûüÿñçăâîșțĂÂÎȘȚ0-9]/g, "").length;
    if (level === 1) {
      // Level 1: first letter + total length (rest masked).
      let revealedFirst = false;
      const masked = answer
        .split("")
        .map((ch) => {
          if (/[a-zA-ZàâäéèêëïîôöùûüÿñçăâîșțĂÂÎȘȚ0-9]/.test(ch) && !revealedFirst) {
            revealedFirst = true;
            return ch;
          }
          return maskChar(ch);
        })
        .join("");
      return `${hideLastLetterIfNothingHidden(masked, answer)}  (${letterCount} letter${letterCount === 1 ? "" : "s"})`;
    }
    if (level === 2) {
      // Level 2: ~40% of letters revealed, deterministic positions (not
      // random — the same card always gives the same hint).
      let letterIndex = -1;
      const partial = answer
        .split("")
        .map((ch) => {
          if (!/[a-zA-ZàâäéèêëïîôöùûüÿñçăâîșțĂÂÎȘȚ0-9]/.test(ch)) return ch;
          letterIndex++;
          return letterIndex % 5 < 2 ? ch : "_"; // ~40% (2 out of every 5)
        })
        .join("");
      return hideLastLetterIfNothingHidden(partial, answer);
    }
    // Level 3: the whole answer minus the last word (multi-word) or minus
    // the last 3 alphanumeric characters (single word) — never 100%
    // identical to the full answer.
    const words = answer.split(" ");
    if (words.length > 1) {
      return words.slice(0, -1).join(" ") + " " + words[words.length - 1].replace(/[a-zA-ZàâäéèêëïîôöùûüÿñçăâîșțĂÂÎȘȚ0-9]/g, "_");
    }
    let hiddenBudget = Math.min(3, letterCount);
    return answer
      .split("")
      .reverse()
      .map((ch) => {
        if (hiddenBudget > 0 && /[a-zA-ZàâäéèêëïîôöùûüÿñçăâîșțĂÂÎȘȚ0-9]/.test(ch)) {
          hiddenBudget--;
          return "_";
        }
        return ch;
      })
      .reverse()
      .join("");
  }

  // normalizeCard keeps backward compatibility with cards saved before
  // categories/stats/tags/images existed: any missing field gets a safe
  // default, once, on read.
  // Imported decks come from other people, so fields that end up in HTML are checked strictly:
  // an image must be a real base64 data URL, a date must look like YYYY-MM-DD.
  const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function normalizeCard(card) {
    return {
      id: card.id || generateId(),
      question: card.question || "",
      answer: card.answer || "",
      category: card.category && String(card.category).trim() ? String(card.category).trim() : "General",
      tags: Array.isArray(card.tags)
        ? [...new Set(card.tags.map((t) => String(t).trim()).filter(Boolean))]
        : [],
      image: typeof card.image === "string" && DATA_IMAGE_RE.test(card.image) ? card.image : null,
      interval: typeof card.interval === "number" ? card.interval : 1,
      repetitionCount: typeof card.repetitionCount === "number" ? card.repetitionCount : 0,
      easeFactor: typeof card.easeFactor === "number" ? card.easeFactor : 2.5,
      nextReviewDate: typeof card.nextReviewDate === "string" && ISO_DATE_RE.test(card.nextReviewDate) ? card.nextReviewDate : getTodayString(),
      lastReviewed: typeof card.lastReviewed === "string" && ISO_DATE_RE.test(card.lastReviewed) ? card.lastReviewed : null,
      hardCount: typeof card.hardCount === "number" ? card.hardCount : 0,
      okCount: typeof card.okCount === "number" ? card.okCount : 0,
      easyCount: typeof card.easyCount === "number" ? card.easyCount : 0,
    };
  }

  // ---------- Utilities ----------
  function formatDate(date) {
    return date.toISOString().split("T")[0]; // YYYY-MM-DD
  }

  function getTodayString() {
    return formatDate(new Date());
  }

  function generateId() {
    // globalThis: the same object as window in the browser, and it also exists in Node (tests)
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `card-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // Safe both as element text and inside attribute values (value="..."): & < > " ' all become
  // entities. The old textContent -> innerHTML trick left quotes alone, so a quote in a card's
  // text (e.g. from an imported deck) could break out of value="..." and add attributes.
  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseTagsInput(value) {
    return [...new Set(value.split(",").map((t) => t.trim()).filter(Boolean))];
  }

  // Normalization for comparing the user's typed answer against the
  // correct one: strips accents and differences in case/spacing/trailing
  // punctuation, but otherwise requires an exact match. It's a hint, not
  // an infallible judgment -- "Paris" vs "The city of Paris" will still
  // come out "no match" even though the user knew the answer. That's why
  // it stays separate from the manual Hard/Ok/Easy grading.
  function normalizeAnswerForCompare(text) {
    return text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[.,!?;:"'()]+$/g, "")
      .replace(/\s+/g, " ");
  }

  // ---------- Step 4: Interval logic (Hard / Ok / Easy) ----------
  // Simplified variant of the SM-2 algorithm — a didactic approximation, not SM-2 "by the book".
  // `today` defaults to now; the tests pass a fixed date.
  // Intervals are capped: without a cap each Easy multiplied the interval by up to ~3.9, and
  // around the 15th Easy on the same card (easy to reach in "All cards" practice) the next date
  // went past the largest date JavaScript can hold and grading crashed (found by the tests).
  const MAX_INTERVAL_DAYS = 365;
  function evaluateCard(card, grade, today = new Date()) {
    card.lastReviewed = formatDate(today);

    if (grade === "hard") {
      card.hardCount += 1;
      card.repetitionCount = 0;
      card.easeFactor = Math.max(1.3, card.easeFactor - 0.2);
      card.interval = 1;
    } else {
      if (grade === "easy") card.easyCount += 1;
      else card.okCount += 1;

      card.easeFactor = grade === "easy"
        ? Math.min(3.0, card.easeFactor + 0.15)
        : Math.max(1.3, card.easeFactor - 0.02);

      if (card.repetitionCount === 0) {
        card.interval = grade === "easy" ? 2 : 1;
      } else if (card.repetitionCount === 1) {
        card.interval = grade === "easy" ? 4 : 3;
      } else {
        card.interval = Math.round(card.interval * card.easeFactor);
        if (grade === "easy") card.interval = Math.round(card.interval * 1.3);
      }

      card.repetitionCount += 1;
    }

    card.interval = Math.min(card.interval, MAX_INTERVAL_DAYS);
    const nextDate = new Date(today);
    nextDate.setDate(nextDate.getDate() + card.interval);
    card.nextReviewDate = formatDate(nextDate);

    return card;
  }

  // ---------- Step 5: Dashboard & due-card filtering ----------
  function getDueCards(cards, today = getTodayString()) {
    return cards.filter((card) => card.nextReviewDate <= today);
  }

  // ---------- Categories ----------
  function getCategories(cards) {
    return [...new Set(cards.map((c) => c.category))].sort((a, b) => a.localeCompare(b));
  }

  // ---------- Statistics ----------
  function computeCategoryStats(cards) {
    const map = new Map();
    cards.forEach((card) => {
      if (!map.has(card.category)) map.set(card.category, { category: card.category, hard: 0, ok: 0, easy: 0 });
      const entry = map.get(card.category);
      entry.hard += card.hardCount;
      entry.ok += card.okCount;
      entry.easy += card.easyCount;
    });

    return [...map.values()]
      .map((entry) => {
        const total = entry.hard + entry.ok + entry.easy;
        return { ...entry, total, successRate: total > 0 ? (entry.ok + entry.easy) / total : null };
      })
      .filter((entry) => entry.total > 0)
      .sort((a, b) => b.successRate - a.successRate);
  }

  // Reads the Question/Answer pairs out of the AI's reply. The prompt asks for a bare JSON
  // array, but a model may still wrap it in a ```json fence or add a sentence around it, so:
  // fence first, then the whole text as JSON, then the first [...] found in it. Anything
  // that isn't a list of {question, answer} strings is dropped; [] means "nothing usable".
  function extractQuestionAnswerPairs(rawText) {
    let jsonText = String(rawText || "").trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) jsonText = fenceMatch[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
      if (!arrayMatch) return [];
      try {
        parsed = JSON.parse(arrayMatch[0]);
      } catch (err2) {
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.question === "string" && typeof item.answer === "string")
      .map((item) => ({ question: item.question.trim(), answer: item.answer.trim() }))
      .filter((item) => item.question && item.answer);
  }

// In Node (the tests) `module` exists and the functions are exported; in the browser it doesn't,
// so this is skipped and the functions above stay plain globals for app.js.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CATEGORY_PALETTE_KEYS, getCategoryColorKey, buildHintForLevel, normalizeCard,
    formatDate, getTodayString, generateId, escapeHtml, parseTagsInput, normalizeAnswerForCompare,
    evaluateCard, getDueCards, getCategories, computeCategoryStats, extractQuestionAnswerPairs,
  };
}
