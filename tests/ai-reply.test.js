// Tests for extractQuestionAnswerPairs() in logic.js: reading the cards out of the AI's reply.
// The prompt asks for a bare JSON array, but a model doesn't always obey, and a reply can be
// cut off. Each test is one shape of reply the app could get back. No browser, no API call.
// Run:  node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractQuestionAnswerPairs: read } = require("../logic.js");

const TWO = [{ question: "What is a test case?", answer: "Steps with an expected result." },
             { question: "What does SRS stand for?", answer: "Spaced repetition system." }];

test("a bare JSON array, as the prompt asks", () => {
  assert.deepEqual(read(JSON.stringify(TWO)), TWO);
});

test("an array inside a ```json fence", () => {
  assert.deepEqual(read("```json\n" + JSON.stringify(TWO, null, 2) + "\n```"), TWO);
});

test("an array inside a plain ``` fence, with text before it", () => {
  assert.deepEqual(read("Here are your cards:\n```\n" + JSON.stringify(TWO) + "\n```"), TWO);
});

test("an array with a sentence before and after it, no fence", () => {
  assert.deepEqual(read("Sure! " + JSON.stringify(TWO) + " Let me know if you want more."), TWO);
});

test("spaces around questions and answers are trimmed", () => {
  assert.deepEqual(read('[{"question": "  Q?  ", "answer": "\\n A. "}]'), [{ question: "Q?", answer: "A." }]);
});

test("items that aren't a question/answer pair of strings are dropped, the rest kept", () => {
  const reply = JSON.stringify([
    TWO[0],
    { question: "No answer" },
    { question: 42, answer: "not a string question" },
    { question: "   ", answer: "blank question" },
    { question: "Blank answer", answer: "" },
    null,
    "just a string",
    TWO[1],
  ]);
  assert.deepEqual(read(reply), TWO);
});

test("a reply cut off in the middle of the array gives nothing usable", () => {
  // what a reply stopped at the token limit looks like
  const cut = JSON.stringify(TWO).slice(0, -20);
  assert.deepEqual(read(cut), []);
});

test("not JSON at all, or JSON that isn't a list, gives nothing usable", () => {
  assert.deepEqual(read("I can't create cards from this material."), []);
  assert.deepEqual(read('{"question": "Q", "answer": "A"}'), []);
  assert.deepEqual(read("[not, valid, json]"), []);
  assert.deepEqual(read(""), []);
  assert.deepEqual(read(undefined), []);
});

test("diacritics and other languages come through unchanged", () => {
  const ro = [{ question: "Ce înseamnă „regresie”?", answer: "Ceva ce mergea și s-a stricat." }];
  assert.deepEqual(read(JSON.stringify(ro)), ro);
});
