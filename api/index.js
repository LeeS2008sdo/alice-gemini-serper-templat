const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 2;
const MAX_HISTORY_MESSAGE_CHARS = 300;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4200;

const SYSTEM_PROMPT = "Ты голосовой ассистент Алиса. Отвечай мгновенно, без рассуждений, строго 1 короткое предложение.";

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 100 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function askGeminiFast(text, history, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 200) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  contents.push({ role: "user", parts: [{ text }] });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { 
          parts: [{ text: "Ты голосовой ассистент Алиса. Отвечай сразу, строго 1 предложение, без вступительных слов и списков." }] 
        },
        contents,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 50
        }
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const status = Number(response.status || 500);
      if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
      if (status === 429) throw new Error("GEMINI_QUOTA");
      throw new Error("GEMINI_REQUEST_FAILED");
    }

    const candidate = data?.candidates?.[0];
    const answer = (candidate?.content?.parts || [])
      .map(p => typeof p.text === "string" ? p.text : "")
      .join("")
      .trim();

    if (!answer) throw new Error("GEMINI_EMPTY_RESPONSE");
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

function errorForUser(error) {
  const msg = error?.message || String(error);
  switch (msg) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте GEMINI_API_KEY.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось авторизоваться в нейросети. Проверьте ключ API.";
    case "GEMINI_QUOTA":
      return "Превышен лимит запросов к нейросети. Попробуйте через минуту.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте ещё раз чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "Webhook is ready." });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! О чем хотите поговорить?",
      false,
      oldHistory
    ));
  }

  try {
    const answer = await askGeminiFast(
      text,
      oldHistory,
      Math.max(100, remainingMs() - 100)
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const isAbort = error?.name === "AbortError" || error?.message === "AbortError";
    const errorType = isAbort ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Fallback returned:", error?.message || error);
    return res.status(200).json(aliceResponse(errorForUser(errorType), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, safeHistory };
