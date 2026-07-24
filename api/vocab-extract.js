const MAX_IMAGE_BYTES = 8000000; // base64 length guard
const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MODEL = "claude-sonnet-5";

const EXTRACT_PROMPT =
  "This photo is a page from a Korean student's English vocabulary textbook. " +
  "The layout is: a book title near the top, a \"Vocabulary\" label, a chapter name below it, " +
  "a boxed list of the words to learn, and then a table listing each word with its English meaning/definition " +
  "and its Korean meaning (한글 뜻). " +
  "Read the page and respond with ONLY a single JSON object, no markdown code fences, no commentary, " +
  "matching exactly this shape: " +
  "{\"book\":\"\",\"chapter\":\"\",\"words\":[{\"word\":\"\",\"meaning\":\"\",\"korean\":\"\"}]}. " +
  "Use the word/meaning/Korean table rows as the source of truth for the words array. " +
  "If the book title or chapter is not clearly visible, leave that field as an empty string. " +
  "If a word's meaning or Korean translation is not visible, leave that field as an empty string.";

function stripJsonFences(text) {
  var trimmed = String(text || "").trim();
  var fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) { return fenced[1].trim(); }
  return trimmed;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(500).json({ error: "missing_api_key" });
      return;
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = null; }
    }
    if (!body || typeof body.image !== "string" || !body.image) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    if (body.image.length > MAX_IMAGE_BYTES) {
      res.status(413).json({ error: "too_large" });
      return;
    }
    const mediaType = ALLOWED_MEDIA_TYPES.indexOf(body.mediaType) !== -1 ? body.mediaType : "image/jpeg";

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: body.image } },
              { type: "text", text: EXTRACT_PROMPT }
            ]
          }
        ]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text().catch(function () { return ""; });
      res.status(502).json({ error: "extract_failed", message: errText.slice(0, 300) });
      return;
    }

    const apiJson = await apiRes.json();
    const rawText = apiJson && apiJson.content && apiJson.content[0] && apiJson.content[0].text;
    if (!rawText) {
      res.status(502).json({ error: "extract_failed" });
      return;
    }

    let parsed;
    try { parsed = JSON.parse(stripJsonFences(rawText)); } catch (e) { parsed = null; }
    if (!parsed || !Array.isArray(parsed.words)) {
      res.status(502).json({ error: "extract_failed" });
      return;
    }

    const words = parsed.words
      .filter(function (w) { return w && typeof w.word === "string" && w.word.trim(); })
      .map(function (w) {
        return {
          word: String(w.word).trim(),
          meaning: typeof w.meaning === "string" ? w.meaning.trim() : "",
          korean: typeof w.korean === "string" ? w.korean.trim() : ""
        };
      });

    res.status(200).json({
      book: typeof parsed.book === "string" ? parsed.book.trim() : "",
      chapter: typeof parsed.chapter === "string" ? parsed.chapter.trim() : "",
      words: words
    });
  } catch (err) {
    res.status(500).json({ error: "server_error", message: String((err && err.message) || err) });
  }
};
