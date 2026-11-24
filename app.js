  // ---------- App state ----------
  const STORAGE_KEY = "flashcards-app-cards";

  const state = {
    cards: [],
    quizQueue: [],
    currentCardIndex: 0,
    selectedCategories: new Set(),
    knownCategories: new Set(),
    quizMode: "due", // "due" = only cards due today; "all" = free practice, any time
    searchQuery: "",
    editingCardId: null,
    pendingImage: null, // image (data URL) attached in the add-card form, before submit
    aiApiKeys: {}, // { anthropic: "sk-ant-..." } — separate from cards, NEVER included in the JSON export
    aiSelectedFile: null, // file chosen for AI generation (File or null)
    aiPreviewCategory: "General",
    aiPreviewTags: [],
    coins: 0, // coin balance — persisted separately, see COINS_STORAGE_KEY
    coinAwardDates: {}, // { [cardId]: "YYYY-MM-DD" } — "all" mode only, anti-farming guard
    currentTipLevel: 0, // hint level unlocked for the current quiz card — resets whenever a new card is shown
  };

  // ---------- Coins & Tips (gamification) ----------
  // State kept fully separate from state.cards, persisted under its own
  // key — not for security reasons (like the API key), but for
  // architectural tidiness, same as the existing decision for aiApiKeys.
  const COINS_STORAGE_KEY = "flashcards-app-coins";

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

  // Grade → coins. "Hard" earns nothing; "Ok" a little; "Easy" more.
  const COINS_PER_GRADE = { hard: 0, ok: 1, easy: 3 };

  // Hint levels: individual (not cumulative) cost per level.
  const TIP_LEVEL_COST = { 1: 2, 2: 4, 3: 6 };

  function loadCoinsState() {
    const raw = localStorage.getItem(COINS_STORAGE_KEY);
    if (!raw) return { balance: 0, coinAwardDates: {} };
    try {
      const parsed = JSON.parse(raw);
      return {
        balance: typeof parsed.balance === "number" && parsed.balance >= 0 ? parsed.balance : 0,
        coinAwardDates: parsed.coinAwardDates && typeof parsed.coinAwardDates === "object" ? parsed.coinAwardDates : {},
      };
    } catch (err) {
      console.error("Error parsing coins from LocalStorage:", err);
      return { balance: 0, coinAwardDates: {} };
    }
  }

  function saveCoinsState() {
    localStorage.setItem(
      COINS_STORAGE_KEY,
      JSON.stringify({ balance: state.coins, coinAwardDates: state.coinAwardDates })
    );
  }

  function renderCoinsHud() {
    coinsBalanceEl.textContent = state.coins;
  }

  // Hangman-style hint mask: letters/digits → "_", everything else
  // (spaces, punctuation) stays visible so the word structure is kept.
  function maskChar(ch) {
    return /[a-zA-Z\u00e0\u00e2\u00e4\u00e9\u00e8\u00ea\u00eb\u00ef\u00ee\u00f4\u00f6\u00f9\u00fb\u00fc\u00ff\u00f1\u00e7\u0103\u00e2\u00ee\u0219\u021b\u0102\u00c2\u00ce\u0218\u021a0-9]/.test(ch) ? "_" : ch;
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
      return `${masked}  (${letterCount} letters)`;
    }
    if (level === 2) {
      // Level 2: ~40% of letters revealed, deterministic positions (not
      // random — the same card always gives the same hint).
      let letterIndex = -1;
      return answer
        .split("")
        .map((ch) => {
          if (!/[a-zA-ZàâäéèêëïîôöùûüÿñçăâîșțĂÂÎȘȚ0-9]/.test(ch)) return ch;
          letterIndex++;
          return letterIndex % 5 < 2 ? ch : "_"; // ~40% (2 out of every 5)
        })
        .join("");
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

  // ---------- Data model & LocalStorage helpers ----------
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

  function getCards() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeCard);
    } catch (err) {
      console.error("Error parsing cards from LocalStorage:", err);
      return [];
    }
  }

  function saveCards(cards) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  }

  // ---------- Utilities ----------
  function formatDate(date) {
    return date.toISOString().split("T")[0]; // YYYY-MM-DD
  }

  function getTodayString() {
    return formatDate(new Date());
  }

  function generateId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
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

  // Resizes a user-picked image to max 480px on its long side and
  // compresses it as JPEG -- otherwise phone photos (several MB) would
  // quickly fill the LocalStorage quota (~5-10MB per site).
  function readImageAsResizedDataUrl(file, maxDimension = 480, quality = 0.72) {
    return new Promise((resolve, reject) => {
      if (!file.type || !file.type.startsWith("image/")) {
        reject(new Error("The selected file is not an image."));
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        reject(new Error("The image is too large (over 8MB). Choose a smaller one."));
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("Error reading the file."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("The file doesn't appear to be a valid image."));
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDimension || height > maxDimension) {
            if (width >= height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function createCard(question, answer, category, tags, image) {
    return normalizeCard({
      id: generateId(),
      question,
      answer,
      category,
      tags,
      image,
      interval: 1,
      repetitionCount: 0,
      easeFactor: 2.5,
      nextReviewDate: getTodayString(),
      lastReviewed: null,
      hardCount: 0,
      okCount: 0,
      easyCount: 0,
    });
  }

  // A small starter deck for first-time visitors (offered only when the deck is empty).
  // Two categories, so the category colors and the quiz category filter show up too.
  const SAMPLE_DECK = [
    { category: "Software testing", question: "What is a regression test?", answer: "A test that checks old features still work after a change" },
    { category: "Software testing", question: "Severity vs. priority of a bug?", answer: "Severity is how bad the bug is; priority is how soon it must be fixed" },
    { category: "Software testing", question: "What does a good bug report contain?", answer: "Steps to reproduce, expected result, actual result, environment" },
    { category: "Software testing", question: "What is a smoke test?", answer: "A quick check that the most important features work at all" },
    { category: "Software testing", question: "What is boundary value analysis?", answer: "Testing at the edges of an input range, like 0, 1, max and max + 1" },
    { category: "Web basics", question: "What does HTTP status 404 mean?", answer: "Not Found" },
    { category: "Web basics", question: "What does HTTP status 500 mean?", answer: "Internal Server Error" },
    { category: "Web basics", question: "Where does this app save your cards?", answer: "In your browser's localStorage" },
  ];

  function loadSampleDeck() {
    // Guard: never mix the sample into (or over) a deck the user already has.
    if (state.cards.length > 0) return;
    // createCard → same defaults and normalization as a hand-made card; all due today.
    state.cards = SAMPLE_DECK.map((c) => createCard(c.question, c.answer, c.category, ["sample"], null));
    saveCards(state.cards);
    renderAll();
  }

  // ---------- Step 4: Interval logic (Hard / Ok / Easy) ----------
  // Simplified variant of the SM-2 algorithm — a didactic approximation, not SM-2 "by the book".
  function evaluateCard(card, grade) {
    const today = new Date();
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

    const nextDate = new Date(today);
    nextDate.setDate(nextDate.getDate() + card.interval);
    card.nextReviewDate = formatDate(nextDate);

    return card;
  }

  // ---------- Step 5: Dashboard & due-card filtering ----------
  function getDueCards(cards) {
    const today = getTodayString();
    return cards.filter((card) => card.nextReviewDate <= today);
  }

  // ---------- Categories ----------
  function getCategories(cards) {
    return [...new Set(cards.map((c) => c.category))].sort((a, b) => a.localeCompare(b));
  }

  // ---------- Search ----------
  function getVisibleCards() {
    const query = state.searchQuery.trim().toLowerCase();
    if (!query) return state.cards;
    return state.cards.filter((card) => {
      const haystack = [card.question, card.answer, card.category, ...card.tags].join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }

  // ---------- DOM rendering: card management (Step 2) ----------
  const cardListEl = document.getElementById("card-list");
  const addCardFormEl = document.getElementById("add-card-form");
  const questionInputEl = document.getElementById("question-input");
  const answerInputEl = document.getElementById("answer-input");
  const categoryInputEl = document.getElementById("category-input");
  const categoryListEl = document.getElementById("category-list");
  const tagsInputEl = document.getElementById("tags-input");
  const dueCounterEl = document.getElementById("due-counter");
  const currentDateEl = document.getElementById("current-date");
  const exportBtnEl = document.getElementById("export-btn");
  const importBtnEl = document.getElementById("import-btn");
  const importFileInputEl = document.getElementById("import-file-input");
  const searchInputEl = document.getElementById("search-input");
  const imageInputEl = document.getElementById("image-input");
  const imagePreviewWrapEl = document.getElementById("image-preview-wrap");
  const imagePreviewEl = document.getElementById("image-preview");
  const removePendingImageBtnEl = document.getElementById("remove-pending-image-btn");

  function renderCardStaticView(card) {
    return `
      <div class="card-list-content">
        <span class="card-list-category cat-soft-${getCategoryColorKey(card.category)}">${escapeHtml(card.category)}</span>
        ${card.image ? `<img class="card-list-thumbnail" src="${escapeHtml(card.image)}" alt="">` : ""}
        <p class="card-list-question">${escapeHtml(card.question)}</p>
        <p class="card-list-answer">${escapeHtml(card.answer)}</p>
        ${
          card.tags.length
            ? `<div class="card-list-tags">${card.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>`
            : ""
        }
        <p class="card-list-meta">Review: ${escapeHtml(card.nextReviewDate)} · Hard ${card.hardCount} · Ok ${card.okCount} · Easy ${card.easyCount}</p>
      </div>
      <div class="card-list-actions">
        <button class="edit-card-btn" data-id="${card.id}" aria-label="Edit card">✎</button>
        <button class="delete-card-btn" data-id="${card.id}" aria-label="Delete card">✕</button>
      </div>
    `;
  }

  function renderCardEditView(card) {
    return `
      <div class="card-list-edit-form">
        <input type="text" class="edit-question-input" value="${escapeHtml(card.question)}" placeholder="Question">
        <input type="text" class="edit-answer-input" value="${escapeHtml(card.answer)}" placeholder="Answer">
        <input type="text" class="edit-category-input" list="category-list" value="${escapeHtml(card.category)}" placeholder="Category">
        <input type="text" class="edit-tags-input" value="${escapeHtml(card.tags.join(", "))}" placeholder="Tags (comma-separated)">
        <div class="edit-image-row">
          ${
            card.image
              ? `<img class="card-list-thumbnail" src="${escapeHtml(card.image)}" alt="">`
              : '<span class="edit-no-image-label">No image</span>'
          }
          <label class="toolbar-btn edit-image-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="M4 17l5-4.5 3.5 3L16 12l4.5 5"/></svg> ${card.image ? "Change" : "Add"} image
            <input type="file" accept="image/*" class="edit-image-input hidden" data-id="${card.id}">
          </label>
          ${card.image ? `<button type="button" class="remove-existing-image-btn" data-id="${card.id}">✕ Remove image</button>` : ""}
        </div>
        <div class="edit-actions">
          <button type="button" class="save-edit-btn" data-id="${card.id}">Save</button>
          <button type="button" class="cancel-edit-btn" data-id="${card.id}">Cancel</button>
        </div>
      </div>
    `;
  }

  function renderCardList() {
    const visibleCards = getVisibleCards();

    if (state.cards.length === 0) {
      cardListEl.innerHTML = `<li class="empty-state">
        <p>You don't have any cards yet. Add one above, or try a sample deck.</p>
        <button type="button" class="sample-deck-btn" id="load-sample-btn">Load sample deck (${SAMPLE_DECK.length} cards)</button>
      </li>`;
      return;
    }

    if (visibleCards.length === 0) {
      cardListEl.innerHTML = '<li class="empty-state">No cards match your search.</li>';
      return;
    }

    cardListEl.innerHTML = "";
    visibleCards.forEach((card) => {
      const li = document.createElement("li");
      const isEditing = card.id === state.editingCardId;
      li.className = isEditing ? "card-list-item card-list-item-editing" : "card-list-item";
      // Colored accent bar per category (QA rule #1) — purely decorative,
      // no text over it, so it uses the "vivid" variant directly.
      li.style.borderLeftColor = `var(--cat-${getCategoryColorKey(card.category)}-vivid)`;
      li.innerHTML = isEditing ? renderCardEditView(card) : renderCardStaticView(card);
      cardListEl.appendChild(li);
    });
  }

  function renderCategoryDatalist() {
    categoryListEl.innerHTML = getCategories(state.cards)
      .map((cat) => `<option value="${escapeHtml(cat)}"></option>`)
      .join("");
  }

  function renderDueCounter() {
    const dueCount = getDueCards(state.cards).length;
    dueCounterEl.textContent = `${dueCount} card${dueCount === 1 ? "" : "s"} due today`;
  }

  // Current date, shown in the header (top-right corner) — computed once
  // on load (no need for a live refresh).
  const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function renderCurrentDate() {
    const today = new Date();
    currentDateEl.textContent = `${EN_MONTHS[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
  }

  function renderAll() {
    renderCardList();
    renderCategoryDatalist();
    renderDueCounter();
    renderQuizStartView();
    renderStats();
  }

  addCardFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = questionInputEl.value.trim();
    const answer = answerInputEl.value.trim();
    if (!question || !answer) return;

    const category = categoryInputEl.value.trim() || "General";
    const tags = parseTagsInput(tagsInputEl.value);
    state.cards.push(createCard(question, answer, category, tags, state.pendingImage));
    saveCards(state.cards);

    questionInputEl.value = "";
    answerInputEl.value = "";
    categoryInputEl.value = "";
    tagsInputEl.value = "";
    state.pendingImage = null;
    imagePreviewEl.src = "";
    imagePreviewWrapEl.classList.add("hidden");
    questionInputEl.focus();

    renderAll();
  });

  imageInputEl.addEventListener("change", async () => {
    const file = imageInputEl.files[0];
    imageInputEl.value = "";
    if (!file) return;
    try {
      const dataUrl = await readImageAsResizedDataUrl(file);
      state.pendingImage = dataUrl;
      imagePreviewEl.src = dataUrl;
      imagePreviewWrapEl.classList.remove("hidden");
    } catch (err) {
      alert(err.message || "Could not load the image.");
    }
  });

  removePendingImageBtnEl.addEventListener("click", () => {
    state.pendingImage = null;
    imagePreviewEl.src = "";
    imagePreviewWrapEl.classList.add("hidden");
  });

  searchInputEl.addEventListener("input", () => {
    state.searchQuery = searchInputEl.value;
    renderCardList();
  });

  // A single delegated listener for all list actions: delete,
  // enter/exit edit mode, save, remove image.
  cardListEl.addEventListener("click", (event) => {
    if (event.target.closest("#load-sample-btn")) {
      loadSampleDeck();
      return;
    }

    const deleteBtn = event.target.closest(".delete-card-btn");
    if (deleteBtn) {
      state.cards = state.cards.filter((card) => card.id !== deleteBtn.dataset.id);
      saveCards(state.cards);
      if (state.editingCardId === deleteBtn.dataset.id) state.editingCardId = null;
      renderAll();
      return;
    }

    const editBtn = event.target.closest(".edit-card-btn");
    if (editBtn) {
      state.editingCardId = editBtn.dataset.id;
      renderCardList();
      return;
    }

    const cancelBtn = event.target.closest(".cancel-edit-btn");
    if (cancelBtn) {
      state.editingCardId = null;
      renderCardList();
      return;
    }

    const saveBtn = event.target.closest(".save-edit-btn");
    if (saveBtn) {
      const li = saveBtn.closest(".card-list-item");
      const card = state.cards.find((c) => c.id === saveBtn.dataset.id);
      if (!card) return;

      const newQuestion = li.querySelector(".edit-question-input").value.trim();
      const newAnswer = li.querySelector(".edit-answer-input").value.trim();
      if (!newQuestion || !newAnswer) {
        alert("Question and answer cannot be empty.");
        return;
      }

      card.question = newQuestion;
      card.answer = newAnswer;
      card.category = li.querySelector(".edit-category-input").value.trim() || "General";
      card.tags = parseTagsInput(li.querySelector(".edit-tags-input").value);

      saveCards(state.cards);
      state.editingCardId = null;
      renderAll();
      return;
    }

    const removeImageBtn = event.target.closest(".remove-existing-image-btn");
    if (removeImageBtn) {
      const card = state.cards.find((c) => c.id === removeImageBtn.dataset.id);
      if (!card) return;
      card.image = null;
      saveCards(state.cards);
      renderCardList(); // stay in edit mode, just refresh
      return;
    }
  });

  // Changing an existing card's image (from edit mode) is applied
  // immediately, without waiting for the "Save" button.
  cardListEl.addEventListener("change", async (event) => {
    const imageInput = event.target.closest(".edit-image-input");
    if (!imageInput) return;

    const file = imageInput.files[0];
    if (!file) return;
    const card = state.cards.find((c) => c.id === imageInput.dataset.id);
    if (!card) return;

    try {
      card.image = await readImageAsResizedDataUrl(file);
      saveCards(state.cards);
      renderCardList();
    } catch (err) {
      alert(err.message || "Could not load the image.");
    }
  });

  // ---------- Import / Export JSON ----------
  // New format (rule #4, decision #4): object { cards, coinsBalance } —
  // coins are legitimate user progress, unlike the API key (intentionally
  // excluded for security reasons), so they deserve to survive an
  // export/import on another computer. We do NOT export coinAwardDates
  // (per-day/per-card anti-farming bookkeeping) — it wouldn't make sense
  // anyway, since imported cards get new IDs.
  function exportCards() {
    const payload = { cards: state.cards, coinsBalance: state.coins };
    const dataStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flashcards-export-${getTodayString()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  exportBtnEl.addEventListener("click", exportCards);
  importBtnEl.addEventListener("click", () => importFileInputEl.click());

  // Import = adds new cards (with new IDs), never overwrites or deletes
  // anything you already have — see the note in CLAUDE.md.
  importFileInputEl.addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        alert("The file is not valid JSON.");
        return;
      }
      // We accept both formats: a plain array (old exports, before
      // Coins & Tips) or the new object { cards, coinsBalance } — see
      // exportCards().
      let cardsArray;
      let importedCoinsBalance = null;
      if (Array.isArray(parsed)) {
        cardsArray = parsed;
      } else if (parsed && Array.isArray(parsed.cards)) {
        cardsArray = parsed.cards;
        if (typeof parsed.coinsBalance === "number" && parsed.coinsBalance >= 0) {
          importedCoinsBalance = parsed.coinsBalance;
        }
      } else {
        alert('The file must contain either a list of cards, or an object with a "cards" field.');
        return;
      }

      const importedCards = cardsArray
        .filter((item) => item && typeof item.question === "string" && typeof item.answer === "string")
        .map((item) => normalizeCard({ ...item, id: generateId() }));

      if (importedCards.length === 0) {
        alert('No valid cards found (each entry needs a "question" and an "answer").');
        return;
      }

      state.cards = [...state.cards, ...importedCards];
      saveCards(state.cards);

      // Imported coins are ADDED to the current balance (consistent with
      // cards, which are added rather than overwriting what you already
      // have) — we don't replace the balance, and we don't import
      // coinAwardDates (irrelevant, since cards get new IDs above).
      if (importedCoinsBalance !== null) {
        state.coins += importedCoinsBalance;
        saveCoinsState();
        renderCoinsHud();
      }

      renderAll();
      alert(
        `${importedCards.length} cards imported successfully.` +
          (importedCoinsBalance !== null ? ` +${importedCoinsBalance} 🪙 coins.` : "")
      );
    };
    reader.readAsText(file);
  });

  // ---------- DOM rendering: Quiz (Step 3 & 4) + category filtering ----------
  const quizStartViewEl = document.getElementById("quiz-start-view");
  const quizSessionViewEl = document.getElementById("quiz-session-view");
  const quizCompleteViewEl = document.getElementById("quiz-complete-view");
  const quizEmptyMessageEl = document.getElementById("quiz-empty-message");
  const startQuizBtnEl = document.getElementById("start-quiz-btn");
  const startQuizCountEl = document.getElementById("start-quiz-count");
  const categoryCheckboxesEl = document.getElementById("category-checkboxes");
  const quizModeRadiosEl = document.querySelectorAll('input[name="quiz-mode"]');
  const backToManageBtnEl = document.getElementById("back-to-manage-btn");
  const flashcardCategoryEl = document.getElementById("flashcard-category");
  const flashcardImageEl = document.getElementById("flashcard-image");
  const flashcardQuestionEl = document.getElementById("flashcard-question");
  const flashcardAnswerEl = document.getElementById("flashcard-answer");
  const userAnswerInputEl = document.getElementById("user-answer-input");
  const answerFeedbackEl = document.getElementById("answer-feedback");
  const showAnswerBtnEl = document.getElementById("show-answer-btn");
  const gradeButtonsEl = document.getElementById("grade-buttons");
  const quizProgressEl = document.getElementById("quiz-progress");
  const coinsBalanceEl = document.getElementById("coins-balance");
  const tipsPanelEl = document.getElementById("tips-panel");
  const hintBoxEl = document.getElementById("hint-box");
  const tipButtonsEl = document.getElementById("tip-buttons");
  const tipBtnEls = { 1: document.getElementById("tip-btn-1"), 2: document.getElementById("tip-btn-2"), 3: document.getElementById("tip-btn-3") };

  function renderCategoryFilter() {
    const categories = getCategories(state.cards);

    // Newly-seen categories (from a freshly added card) are checked by
    // default, so cards don't "disappear" from the quiz unexpectedly.
    categories.forEach((cat) => {
      if (!state.knownCategories.has(cat)) {
        state.knownCategories.add(cat);
        state.selectedCategories.add(cat);
      }
    });

    categoryCheckboxesEl.innerHTML = categories
      .map(
        (cat) => `
        <label class="category-checkbox cat-soft-${getCategoryColorKey(cat)}">
          <input type="checkbox" value="${escapeHtml(cat)}" ${state.selectedCategories.has(cat) ? "checked" : ""}>
          <span>${escapeHtml(cat)}</span>
        </label>
      `
      )
      .join("");
  }

  // "due" follows the spaced-repetition algorithm (only cards due today);
  // "all" is free-practice mode — you can redo the quiz as many times as you
  // like, over all cards in the selected categories, regardless of nextReviewDate.
  function getQuizCandidates() {
    const pool = state.quizMode === "all" ? state.cards : getDueCards(state.cards);
    return pool.filter((card) => state.selectedCategories.has(card.category));
  }

  function updateQuizStartCount() {
    const candidates = getQuizCandidates();
    startQuizCountEl.textContent = candidates.length;
    startQuizBtnEl.classList.toggle("hidden", candidates.length === 0);
    quizEmptyMessageEl.classList.toggle("hidden", candidates.length > 0);
    // Distinguish "you have zero cards, period" from "you have cards but none
    // match the current mode/filters" — suggesting a mode switch is useless
    // (and confusing) advice when the deck itself is empty.
    quizEmptyMessageEl.textContent = state.cards.length === 0
      ? "You don't have any cards yet. Add some in the Cards tab to get started."
      : state.quizMode === "all"
      ? "You don't have any cards in the selected categories."
      : "You have no cards due today. Try “All cards” mode if you want to practice anyway.";
  }

  function renderQuizStartView() {
    renderCategoryFilter();
    updateQuizStartCount();
  }

  categoryCheckboxesEl.addEventListener("change", (event) => {
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    if (checkbox.checked) state.selectedCategories.add(checkbox.value);
    else state.selectedCategories.delete(checkbox.value);
    updateQuizStartCount();
  });

  quizModeRadiosEl.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) state.quizMode = radio.value;
      updateQuizStartCount();
    });
  });

  startQuizBtnEl.addEventListener("click", () => {
    state.quizQueue = getQuizCandidates();
    state.currentCardIndex = 0;

    quizStartViewEl.classList.add("hidden");
    quizCompleteViewEl.classList.add("hidden");
    quizSessionViewEl.classList.remove("hidden");

    renderCurrentQuizCard();
  });

  backToManageBtnEl.addEventListener("click", () => {
    quizCompleteViewEl.classList.add("hidden");
    quizStartViewEl.classList.remove("hidden");
    document.querySelector('[data-tab="manage-tab"]').click();
  });

  function renderCurrentQuizCard() {
    const card = state.quizQueue[state.currentCardIndex];
    if (!card) {
      quizSessionViewEl.classList.add("hidden");
      quizCompleteViewEl.classList.remove("hidden");
      return;
    }

    flashcardCategoryEl.textContent = card.category;
    flashcardCategoryEl.style.background = `var(--cat-${getCategoryColorKey(card.category)}-soft)`;

    // Reset Tips per card (rule #4, decision #4): unlocked levels do NOT
    // stay permanently on the card — they reset on every display, so active
    // recall keeps its value on future reappearances.
    state.currentTipLevel = 0;
    hintBoxEl.textContent = "";
    hintBoxEl.classList.remove("visible");
    tipsPanelEl.classList.remove("hidden");
    updateTipButtons();

    if (card.image) {
      flashcardImageEl.src = card.image;
      flashcardImageEl.classList.remove("hidden");
    } else {
      flashcardImageEl.src = "";
      flashcardImageEl.classList.add("hidden");
    }

    flashcardQuestionEl.textContent = card.question;
    // Important: we do NOT put card.answer in the DOM here. The answer is
    // only written when the user clicks "Show Answer" — otherwise it would
    // already be sitting on the page (just visually hidden with CSS),
    // inspectable from DevTools.
    flashcardAnswerEl.textContent = "";
    flashcardAnswerEl.classList.add("hidden");
    gradeButtonsEl.classList.add("hidden");
    showAnswerBtnEl.classList.remove("hidden");

    userAnswerInputEl.value = "";
    userAnswerInputEl.disabled = false;

    answerFeedbackEl.textContent = "";
    answerFeedbackEl.classList.add("hidden");
    answerFeedbackEl.classList.remove("answer-feedback-match", "answer-feedback-mismatch");

    quizProgressEl.textContent = `Card ${state.currentCardIndex + 1} of ${state.quizQueue.length}`;
    const progressFillEl = document.getElementById("quiz-progress-fill");
    if (progressFillEl) {
      const pct = state.quizQueue.length ? ((state.currentCardIndex + 1) / state.quizQueue.length) * 100 : 0;
      progressFillEl.style.transform = `translateX(${pct - 100}%)`; // 0% done = fully left, 100% = in place
    }
  }

  showAnswerBtnEl.addEventListener("click", () => {
    const card = state.quizQueue[state.currentCardIndex];
    flashcardAnswerEl.textContent = card.answer;
    flashcardAnswerEl.classList.remove("hidden");
    showAnswerBtnEl.classList.add("hidden");
    gradeButtonsEl.classList.remove("hidden");
    userAnswerInputEl.disabled = true;

    // Tips only make sense before reveal (rule #4, decision #3) —
    // afterward, they disappear completely.
    tipsPanelEl.classList.add("hidden");

    // A visual cue, not an infallible judgment: we compare the normalized
    // text (no diacritics/casing/trailing punctuation) only if the user
    // typed something. The real evaluation always stays manual, via
    // Hard/Ok/Easy — that's what feeds the spaced-repetition algorithm.
    const typedAnswer = userAnswerInputEl.value;
    if (typedAnswer.trim() !== "") {
      const isMatch = normalizeAnswerForCompare(typedAnswer) === normalizeAnswerForCompare(card.answer);
      answerFeedbackEl.textContent = isMatch
        ? "✓ Your answer matches the correct one."
        : "✗ Your answer doesn't exactly match the correct one — compare below and decide for yourself with Hard/Ok/Easy.";
      answerFeedbackEl.classList.remove("hidden");
      answerFeedbackEl.classList.toggle("answer-feedback-match", isMatch);
      answerFeedbackEl.classList.toggle("answer-feedback-mismatch", !isMatch);
    }
  });

  // Enter in the own-answer field = a shortcut for "Show Answer".
  userAnswerInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !showAnswerBtnEl.classList.contains("hidden")) {
      event.preventDefault();
      showAnswerBtnEl.click();
    }
  });

  gradeButtonsEl.addEventListener("click", (event) => {
    const gradeBtn = event.target.closest(".grade-btn");
    if (!gradeBtn) return;

    const card = state.quizQueue[state.currentCardIndex];
    const grade = gradeBtn.dataset.grade;
    evaluateCard(card, grade);

    // Coins (rule #4, decision #1): ONLY from the manual Hard/Ok/Easy
    // evaluation — never from normalizeAnswerForCompare(), which stays
    // completely separate. In "All cards" mode (free practice), a card
    // awards coins only once per calendar day — otherwise the user could
    // generate unlimited coins by repeating the same card forever.
    const today = getTodayString();
    const alreadyAwardedToday = state.quizMode === "all" && state.coinAwardDates[card.id] === today;
    if (!alreadyAwardedToday) {
      state.coins += COINS_PER_GRADE[grade] || 0;
      if (state.quizMode === "all") state.coinAwardDates[card.id] = today;
      saveCoinsState();
      renderCoinsHud();
    }

    const mainCardIndex = state.cards.findIndex((c) => c.id === card.id);
    if (mainCardIndex !== -1) state.cards[mainCardIndex] = card;
    saveCards(state.cards);

    renderAll();

    state.currentCardIndex += 1;
    renderCurrentQuizCard();
  });

  // ---------- Tips (rule #4, decisions #2 and #3) ----------
  // The buttons stay visible even if the user doesn't have enough coins
  // (not just silently disabled) — the title explains why, per the
  // edge-case checklist in QA_agent.md.
  function updateTipButtons() {
    const level = state.currentTipLevel;
    [1, 2, 3].forEach((lvl) => {
      const btn = tipBtnEls[lvl];
      const bought = level >= lvl;
      btn.classList.toggle("hidden", bought);
      if (bought) return;
      const prevRequirementMet = lvl === 1 || level >= lvl - 1;
      const canAfford = state.coins >= TIP_LEVEL_COST[lvl];
      btn.disabled = !prevRequirementMet || !canAfford;
      btn.title = !prevRequirementMet
        ? "Buy the previous hint first"
        : !canAfford
        ? `Not enough coins (cost ${TIP_LEVEL_COST[lvl]})`
        : "";
    });
  }

  tipButtonsEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".tip-btn");
    if (!btn || btn.disabled) return;

    const level = Number(btn.dataset.level);
    const cost = TIP_LEVEL_COST[level];
    if (state.coins < cost) return; // extra guard — balance can never go negative

    const card = state.quizQueue[state.currentCardIndex];
    state.coins -= cost;
    state.currentTipLevel = level;

    // The hint is rendered into a SEPARATE element (#hint-box) from
    // #flashcard-answer — the confidentiality rule stays literally true
    // for the full answer (see the documented exception in CLAUDE.md for
    // this partial hint).
    hintBoxEl.textContent = buildHintForLevel(card.answer, level);
    hintBoxEl.classList.add("visible");

    saveCoinsState();
    renderCoinsHud();
    updateTipButtons();
  });

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

  const statsContentEl = document.getElementById("stats-content");

  function renderStats() {
    const reviewedCards = state.cards.filter((c) => c.hardCount + c.okCount + c.easyCount > 0);

    if (reviewedCards.length === 0) {
      statsContentEl.innerHTML = '<p class="empty-state">No stats yet — take a quiz to see how you\'re doing.</p>';
      return;
    }

    const bestCards = [...reviewedCards]
      .sort((a, b) => b.easeFactor - a.easeFactor || b.easyCount - a.easyCount)
      .slice(0, 5);

    const strugglingCards = reviewedCards.filter((c) => c.hardCount > 0);
    const worstCards = [...strugglingCards]
      .sort((a, b) => b.hardCount - a.hardCount || a.easeFactor - b.easeFactor)
      .slice(0, 5);

    const categoryStats = computeCategoryStats(state.cards);

    const renderCardStatItem = (card) => `
      <li class="stat-card-item">
        <span class="stat-card-question">${escapeHtml(card.question)}</span>
        <span class="stat-card-meta">Hard ${card.hardCount} · Ok ${card.okCount} · Easy ${card.easyCount}</span>
      </li>
    `;

    const renderCategoryRow = (entry) => `
      <li class="stat-category-item">
        <span class="stat-category-name">${escapeHtml(entry.category)}</span>
        <span class="stat-category-rate">${Math.round(entry.successRate * 100)}% success · ${entry.total} review${entry.total === 1 ? "" : "s"}</span>
      </li>
    `;

    statsContentEl.innerHTML = `
      <div class="stats-summary">
        <div class="stats-summary-item"><strong>${state.cards.length}</strong><span>total cards</span></div>
        <div class="stats-summary-item"><strong>${reviewedCards.length}</strong><span>reviewed</span></div>
      </div>

      <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg> Best known</h2>
      <ul class="stat-card-list">${bestCards.map(renderCardStatItem).join("")}</ul>

      <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4.5l8.5 14.5H3.5L12 4.5z"/><path d="M12 10v4.2M12 17h.01"/></svg> Needs work</h2>
      ${
        worstCards.length > 0
          ? `<ul class="stat-card-list">${worstCards.map(renderCardStatItem).join("")}</ul>`
          : '<p class="empty-state">No difficult questions right now.</p>'
      }

      <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19V10M10 19V5M16 19v-7M20 19H3"/></svg> Categories, best to worst</h2>
      <ul class="stat-category-list">${categoryStats.map(renderCategoryRow).join("")}</ul>
    `;
  }

  // ---------- Tab navigation ----------
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabPanels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });

  // ---------- Theme (dark mode) ----------
  const THEME_STORAGE_KEY = "flashcards-app-theme";
  const themeToggleBtnEl = document.getElementById("theme-toggle-btn");

  function getEffectiveTheme() {
    const explicit = document.documentElement.getAttribute("data-theme");
    if (explicit) return explicit;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  const MOON_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 14.5a8 8 0 1 1-9.3-10.4 6.3 6.3 0 0 0 9.3 10.4z"/></svg>';
  const SUN_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>';

  function applyTheme(theme) {
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    themeToggleBtnEl.innerHTML = getEffectiveTheme() === "dark" ? SUN_ICON_SVG : MOON_ICON_SVG;
  }

  themeToggleBtnEl.addEventListener("click", () => {
    const next = getEffectiveTheme() === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  });

  // ---------- AI generation (BYOK) ----------
  const AI_KEYS_STORAGE_KEY = "flashcards-app-api-keys";
  // The only supported model, deliberately not customizable from the UI —
  // see the hint in the "Generate Cards" section and CLAUDE.md for the
  // reasoning behind this decision.
  const AI_MODEL = "claude-sonnet-5";
  // Accepted extensions for the source document. .doc/.docx are
  // intentionally not supported: .docx is a DEFLATE-compressed ZIP+XML
  // archive, and old .doc is a binary OLE format — both would need an
  // external parsing library, which contradicts the no-build/no-
  // dependencies architecture.
  const AI_ACCEPTED_EXTENSIONS = [".pdf", ".txt", ".md"];

  // ---------- Demo mode (no API key, no real model call) ----------
  // A recruiter looking at the portfolio won't paste in their own Anthropic
  // key just to see this feature work. "Try the demo" loads a short built-in
  // document and shows a pre-written set of cards through the exact same
  // preview/confirm UI as a real generation — clearly labelled as a demo
  // (see the #ai-demo-banner toggle in showAiPreview) so it's never mistaken
  // for a live result.
  const DEMO_DOC_TEXT = `Manual QA Testing: Core Concepts

Quality assurance (QA) testing checks that software behaves the way it's supposed to before it reaches real users. A tester's job isn't just clicking around - it's comparing actual behavior against expected behavior, and writing down exactly what happened when they don't match.

A test case is the basic unit of manual testing. It names a precondition (what state the app must be in before starting), the exact steps to follow, and the expected result. A good test case is specific enough that two different testers running it would reach the same pass/fail verdict.

Smoke testing is a quick pass over the most critical paths of an application - login, checkout, the core feature - run right after a new build to catch anything badly broken before deeper testing starts. Regression testing re-runs existing test cases after a code change, to catch cases where a fix for one thing broke something else that used to work. Exploratory testing has no fixed script: the tester actively investigates the app, following their own judgment and curiosity to find issues a written test case wouldn't think to check.

A bug report needs four things to be useful to a developer: the steps to reproduce it, what actually happened, what was expected to happen instead, and the environment it was found in (browser, OS, app version). Severity describes how bad the bug is on its own - does it crash the app, or just look slightly off? Priority describes how soon it needs fixing, which depends on severity but also on things like how many users are affected and whether a release is close. A low-severity bug can still be high-priority - for example a typo in a company's name on the homepage right before a product launch.

Acceptance criteria are the conditions a feature must satisfy to be considered "done." Testing against acceptance criteria is how a tester checks that what was built actually matches what was asked for, not just that it doesn't crash.`;

  const DEMO_CARD_PAIRS = [
    { question: "What is the basic unit of manual testing, and what three things does it name?", answer: "A test case - it names a precondition, the exact steps to follow, and the expected result." },
    { question: "What makes a test case “good”, according to the text?", answer: "It's specific enough that two different testers running it would reach the same pass/fail verdict." },
    { question: "What is smoke testing, and when is it run?", answer: "A quick pass over an application's most critical paths (e.g. login, checkout, the core feature), run right after a new build to catch anything badly broken before deeper testing starts." },
    { question: "What does regression testing check for?", answer: "It re-runs existing test cases after a code change, to catch cases where a fix for one thing broke something else that used to work." },
    { question: "How does exploratory testing differ from scripted testing?", answer: "It has no fixed script - the tester actively investigates the app using their own judgment and curiosity to find issues a written test case wouldn't think to check." },
    { question: "What four things does a useful bug report need?", answer: "Steps to reproduce it, what actually happened, what was expected to happen instead, and the environment it was found in (browser, OS, app version)." },
    { question: "What's the difference between severity and priority?", answer: "Severity describes how bad the bug is on its own (e.g. does it crash the app); priority describes how soon it needs fixing, which depends on severity plus factors like how many users are affected." },
    { question: "Give the text's example of a low-severity bug that's still high-priority.", answer: "A typo in a company's name on the homepage right before a product launch." },
    { question: "What are acceptance criteria used for?", answer: "The conditions a feature must satisfy to be considered “done” - testing against them checks that what was built actually matches what was asked for, not just that it doesn't crash." },
  ];

  const anthropicKeyInputEl = document.getElementById("anthropic-key-input");
  const saveKeyBtnEl = document.getElementById("save-key-btn");
  const apiKeyStatusEl = document.getElementById("api-key-status");
  const clearKeyBtnEl = document.getElementById("clear-key-btn");
  const aiGenerateFormEl = document.getElementById("ai-generate-form");
  const aiDropzoneEl = document.getElementById("ai-dropzone");
  const aiFileInputEl = document.getElementById("ai-file-input");
  const aiFileChipEl = document.getElementById("ai-file-chip");
  const aiFileNameEl = document.getElementById("ai-file-name");
  const removeAiFileBtnEl = document.getElementById("remove-ai-file-btn");
  const aiPastedTextEl = document.getElementById("ai-pasted-text");
  const aiQuestionCountEl = document.getElementById("ai-question-count");
  const aiCategoryInputEl = document.getElementById("ai-category-input");
  const aiTagsInputEl = document.getElementById("ai-tags-input");
  const generateAiBtnEl = document.getElementById("generate-ai-btn");
  const aiErrorBoxEl = document.getElementById("ai-error-box");
  const aiPreviewSectionEl = document.getElementById("ai-preview-section");
  const aiPreviewListEl = document.getElementById("ai-preview-list");
  const confirmAiBtnEl = document.getElementById("confirm-ai-btn");
  const discardAiBtnEl = document.getElementById("discard-ai-btn");
  const tryAiDemoBtnEl = document.getElementById("try-ai-demo-btn");
  const aiDemoBannerEl = document.getElementById("ai-demo-banner");

  function loadApiKeys() {
    try {
      const raw = localStorage.getItem(AI_KEYS_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function saveApiKeys(keys) {
    localStorage.setItem(AI_KEYS_STORAGE_KEY, JSON.stringify(keys));
  }

  function maskKey(key) {
    if (key.length <= 8) return "••••";
    return `${key.slice(0, 7)}...${key.slice(-4)}`;
  }

  function renderApiKeyStatus() {
    const key = state.aiApiKeys.anthropic;
    if (key) {
      apiKeyStatusEl.textContent = `Key saved: ${maskKey(key)}`;
      clearKeyBtnEl.classList.remove("hidden");
    } else {
      apiKeyStatusEl.textContent = "No key saved yet.";
      clearKeyBtnEl.classList.add("hidden");
    }
  }

  saveKeyBtnEl.addEventListener("click", () => {
    const value = anthropicKeyInputEl.value.trim();
    if (!value) return;
    state.aiApiKeys.anthropic = value;
    saveApiKeys(state.aiApiKeys);
    anthropicKeyInputEl.value = "";
    renderApiKeyStatus();
  });

  clearKeyBtnEl.addEventListener("click", () => {
    delete state.aiApiKeys.anthropic;
    saveApiKeys(state.aiApiKeys);
    renderApiKeyStatus();
  });

  function getFileExtension(file) {
    const match = file.name.toLowerCase().match(/\.[^.]+$/);
    return match ? match[0] : "";
  }

  // Centralized validation — used by both the classic file picker and
  // drag&drop, so the two paths can never diverge in their rules.
  function acceptSelectedFile(file) {
    hideAiError();
    const ext = getFileExtension(file);
    if (ext === ".doc" || ext === ".docx") {
      showAiError("Word files (.doc/.docx) aren't supported directly. Save the document as a PDF (in Word: File > Save As > PDF) or paste the text into the field below.");
      return;
    }
    if (!AI_ACCEPTED_EXTENSIONS.includes(ext)) {
      showAiError(`Unsupported format (${ext || "unknown"}). Only these are accepted: ${AI_ACCEPTED_EXTENSIONS.join(", ")}.`);
      return;
    }
    state.aiSelectedFile = file;
    aiFileNameEl.textContent = file.name;
    aiFileChipEl.classList.remove("hidden");
    aiDropzoneEl.classList.add("hidden");
  }

  function clearSelectedFile() {
    state.aiSelectedFile = null;
    aiFileInputEl.value = "";
    aiFileChipEl.classList.add("hidden");
    aiDropzoneEl.classList.remove("hidden");
  }

  aiDropzoneEl.addEventListener("click", () => aiFileInputEl.click());
  aiDropzoneEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      aiFileInputEl.click();
    }
  });

  aiFileInputEl.addEventListener("change", () => {
    const file = aiFileInputEl.files[0];
    if (!file) return;
    acceptSelectedFile(file);
  });

  removeAiFileBtnEl.addEventListener("click", () => clearSelectedFile());

  // Drag & drop: visual highlight during the drag, validation on drop.
  ["dragenter", "dragover"].forEach((eventName) => {
    aiDropzoneEl.addEventListener(eventName, (event) => {
      event.preventDefault();
      aiDropzoneEl.classList.add("ai-dropzone-active");
    });
  });

  ["dragleave", "dragend"].forEach((eventName) => {
    aiDropzoneEl.addEventListener(eventName, (event) => {
      event.preventDefault();
      aiDropzoneEl.classList.remove("ai-dropzone-active");
    });
  });

  aiDropzoneEl.addEventListener("drop", (event) => {
    event.preventDefault();
    aiDropzoneEl.classList.remove("ai-dropzone-active");
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    acceptSelectedFile(file);
  });

  // A drag&drop anywhere else on the page would navigate the browser to
  // the file — we block the default behavior across the whole AI
  // generation tab.
  const aiTabEl = document.getElementById("ai-tab");
  ["dragover", "drop"].forEach((eventName) => {
    aiTabEl.addEventListener(eventName, (event) => event.preventDefault());
  });

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result);
      reader.readAsText(file);
    });
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve((reader.result.split(",")[1]) || "");
      reader.readAsDataURL(file);
    });
  }

  function buildGenerationPrompt(questionCount) {
    return `You are an assistant that creates study flashcards (Question/Answer) from a given piece of material.

Task: generate exactly up to ${questionCount} Question/Answer pairs, based STRICTLY on the content attached below (file and/or text). Choose questions spread across the entire material — beginning, middle, and end — not just the first paragraphs, to cover as wide a variety of distinct information as possible, not rephrasings of the same idea. Each question must test a concrete piece of information verifiable from the material. Answers should be short and clear (1-3 sentences), not entire paragraphs.

Write the questions and answers in the same language the source material is written in.

Respond STRICTLY with a valid JSON array, with no explanatory text before or after, and no code fences. Exact format:
[{"question": "...", "answer": "..."}]`;
  }

  function extractQuestionAnswerPairs(rawText) {
    let jsonText = rawText.trim();
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

  function setGeneratingState(isGenerating) {
    generateAiBtnEl.disabled = isGenerating;
    generateAiBtnEl.textContent = isGenerating ? "Generating..." : "Generate Cards";
  }

  function showAiError(message) {
    aiErrorBoxEl.textContent = message;
    aiErrorBoxEl.classList.remove("hidden");
  }

  function hideAiError() {
    aiErrorBoxEl.classList.add("hidden");
    aiErrorBoxEl.textContent = "";
  }

  aiGenerateFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideAiError();

    const apiKey = state.aiApiKeys.anthropic;
    if (!apiKey) {
      showAiError("Save an Anthropic API key above first.");
      return;
    }

    const questionCount = Math.min(30, Math.max(1, parseInt(aiQuestionCountEl.value, 10) || 10));
    const category = aiCategoryInputEl.value.trim() || "General";
    const extraTags = parseTagsInput(aiTagsInputEl.value);
    const pastedText = aiPastedTextEl.value.trim();
    const file = state.aiSelectedFile;

    if (!file && !pastedText) {
      showAiError("Attach a file or paste some text — I need a source to work from.");
      return;
    }

    const instructionText = buildGenerationPrompt(questionCount);
    let contentBlocks = [];
    try {
      if (file) {
        const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        if (isPdf) {
          const base64 = await readFileAsBase64(file);
          contentBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } });
          contentBlocks.push({ type: "text", text: instructionText });
        } else {
          const text = await readFileAsText(file);
          contentBlocks.push({ type: "text", text: `${instructionText}\n\n--- SOURCE MATERIAL ---\n${text}` });
        }
      } else {
        contentBlocks.push({ type: "text", text: `${instructionText}\n\n--- SOURCE MATERIAL ---\n${pastedText}` });
      }
    } catch (err) {
      showAiError("Could not read the selected file.");
      return;
    }

    setGeneratingState(true);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 4096, messages: [{ role: "user", content: contentBlocks }] }),
      });
      const data = await response.json();
      if (!response.ok) {
        const message = (data && data.error && data.error.message) || `HTTP error ${response.status}`;
        throw new Error(message);
      }
      // We don't assume the first content block is always text (the
      // response can contain other block types too, e.g. if the model
      // stopped early) — we explicitly look for the first "text" block.
      const textBlock = Array.isArray(data.content) ? data.content.find((block) => block && block.type === "text" && block.text) : null;
      const rawText = textBlock ? textBlock.text : "";
      if (!rawText) {
        // Log the raw response so it can be inspected from the console
        // (F12) — without this, "no usable text" doesn't say why it
        // happened.
        console.error("Anthropic response with no usable text:", data);
        throw new Error(`The response contains no usable text (stop reason: ${data.stop_reason || "unknown"}). Open the browser console (F12) and look for “Anthropic response with no usable text” for full details.`);
      }
      const pairs = extractQuestionAnswerPairs(rawText);
      if (pairs.length === 0) {
        console.error("Received text from Anthropic, but couldn't extract cards from it:", rawText);
        throw new Error("Could not parse the response as a list of questions/answers. See the console (F12) for the raw text received.");
      }
      showAiPreview(pairs, category, extraTags);
    } catch (err) {
      console.error(err);
      // The CORS suffix only makes sense for real network failures
      // (fetch rejected before any response arrives) — otherwise it's
      // confusing to show it for logic errors too (e.g. missing text,
      // unparsable JSON).
      const looksLikeNetworkError = err instanceof TypeError;
      const suffix = looksLikeNetworkError
        ? " This looks like a network problem — also check the browser console (F12); it could be a CORS block or no connection."
        : "";
      showAiError(`Error: ${err.message || "unknown"}.${suffix}`);
    } finally {
      setGeneratingState(false);
    }
  });

  // ---------- Demo mode handler ----------
  // Loads the built-in sample document into the form (purely so the form
  // reflects what's "generating from"), then shows the pre-written card set
  // after a short simulated delay instead of calling the real API. Reuses
  // the exact same preview/confirm UI as a real generation.
  tryAiDemoBtnEl.addEventListener("click", () => {
    hideAiError();
    hideAiPreview();
    clearSelectedFile();
    aiPastedTextEl.value = DEMO_DOC_TEXT;
    aiQuestionCountEl.value = DEMO_CARD_PAIRS.length;
    const category = aiCategoryInputEl.value.trim() || "QA Fundamentals (demo)";
    const extraTags = parseTagsInput(aiTagsInputEl.value);

    setGeneratingState(true);
    tryAiDemoBtnEl.disabled = true;
    window.setTimeout(() => {
      setGeneratingState(false);
      tryAiDemoBtnEl.disabled = false;
      showAiPreview(DEMO_CARD_PAIRS, category, extraTags, true);
    }, 700);
  });

  function showAiPreview(pairs, category, extraTags, isDemo = false) {
    state.aiPreviewCategory = category;
    state.aiPreviewTags = extraTags;
    aiDemoBannerEl.classList.toggle("hidden", !isDemo);
    aiPreviewListEl.innerHTML = pairs
      .map(
        (p) => `
        <li class="ai-preview-item">
          <input type="checkbox" class="ai-preview-checkbox" checked>
          <div class="ai-preview-fields">
            <input type="text" class="ai-preview-question-input" value="${escapeHtml(p.question)}">
            <input type="text" class="ai-preview-answer-input" value="${escapeHtml(p.answer)}">
          </div>
        </li>
      `
      )
      .join("");
    aiPreviewSectionEl.classList.remove("hidden");
  }

  function hideAiPreview() {
    aiPreviewListEl.innerHTML = "";
    aiPreviewSectionEl.classList.add("hidden");
    aiDemoBannerEl.classList.add("hidden");
  }

  confirmAiBtnEl.addEventListener("click", () => {
    const rows = aiPreviewListEl.querySelectorAll(".ai-preview-item");
    let addedCount = 0;
    rows.forEach((row) => {
      const checkbox = row.querySelector(".ai-preview-checkbox");
      if (!checkbox.checked) return;
      const question = row.querySelector(".ai-preview-question-input").value.trim();
      const answer = row.querySelector(".ai-preview-answer-input").value.trim();
      if (!question || !answer) return;
      const tags = [...new Set([...state.aiPreviewTags, "ai-generated"])];
      state.cards.push(createCard(question, answer, state.aiPreviewCategory, tags, null));
      addedCount += 1;
    });
    if (addedCount === 0) {
      alert("Nothing checked — no cards were added.");
      return;
    }
    saveCards(state.cards);
    renderAll();
    hideAiPreview();
    alert(`${addedCount} cards added.`);
  });

  discardAiBtnEl.addEventListener("click", () => {
    hideAiPreview();
  });

  // ---------- Initialization ----------
  function init() {
    applyTheme(localStorage.getItem(THEME_STORAGE_KEY)); // null => follows the system preference
    renderCurrentDate();
    state.aiApiKeys = loadApiKeys();
    renderApiKeyStatus();
    state.cards = getCards();
    saveCards(state.cards); // immediately persist any migration from normalizeCard()

    const coinsState = loadCoinsState();
    state.coins = coinsState.balance;
    state.coinAwardDates = coinsState.coinAwardDates;
    renderCoinsHud();

    renderAll();
  }

  init();
