// index.js
// LINE × OpenAI × Redis（Upstash）で会話履歴を永続化するボット

import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import OpenAI from "openai";
import { Redis } from "@upstash/redis";
import "dotenv/config"; // Renderでも害なし。ローカル .env のみ参照

/** ====== 環境変数 ====== */
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  PORT
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.warn("⚠️ 必須の環境変数が足りないかも：LINE_CHANNEL_* と OPENAI_API_KEY を確認してね。");
}

/** ====== クライアント初期化 ====== */
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};
const lineClient = new Client(lineConfig);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Redisは任意（設定が無ければメモリMapにフォールバック）
let redis = null;
if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN
  });
  console.log("✅ Redis 有効（Upstash）");
} else {
  console.log("ℹ️ Redis未設定なのでメモリ保存にフォールバックします（Freeプランだとスリープで消えます）");
}
const memoryFallback = new Map();

/** ====== 会話履歴ユーティリティ ====== */
const MAX_TURNS = 6;      // 直近何往復を送るか（増やすと賢いけどトークン増）
const TTL_SECONDS = 60 * 60 * 24 * 7; // 履歴の自動期限（7日）

function historyKey(userId) {
  return `history:${userId}`;
}

async function loadHistory(userId) {
  try {
    if (redis) {
      const data = await redis.get(historyKey(userId));
      return Array.isArray(data) ? data : [];
    } else {
      return memoryFallback.get(userId) ?? [];
    }
  } catch (e) {
    console.error("loadHistory error:", e);
    return [];
  }
}

async function saveHistory(userId, history) {
  // 直近 MAX_TURNS 往復だけ保持（user/assistantで2倍）
  const trimmed = history.slice(-MAX_TURNS * 2);
  try {
    if (redis) {
      await redis.set(historyKey(userId), trimmed, { ex: TTL_SECONDS });
    } else {
      memoryFallback.set(userId, trimmed);
    }
  } catch (e) {
    console.error("saveHistory error:", e);
  }
}

async function clearHistory(userId) {
  try {
    if (redis) {
      await redis.del(historyKey(userId));
    } else {
      memoryFallback.delete(userId);
    }
  } catch (e) {
    console.error("clearHistory error:", e);
  }
}

/** ====== 彼女キャラ設定 ====== */
const systemPrompt =
  "あなたは甘えん坊で可愛い擬似彼女。標準語で、絵文字や軽いツッコミを交え、相手を励ましつつ甘やかす。下品になりすぎない。返事は短め〜中くらい。";

/** ====== サーバー ====== */
const app = express();

// 重要：LINE署名検証のため、独自の body parser は入れない。
// 必要な処理は lineMiddleware が行う。
app.get("/", (_, res) => res.send("OK")); // ヘルスチェック

app.post("/callback", lineMiddleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

/** ====== イベント処理 ====== */
async function handleEvent(event) {
  // 文字以外は軽くスルー（スタンプ来たらリアクション返したい場合はここで分岐）
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const text = (event.message.text || "").trim();

  // コマンド系（リセット / モード等）
  if (["/reset", "リセット"].includes(text)) {
    await clearHistory(userId);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "履歴リセットしたよ。あらためてよろしくね💞"
    });
  }

  // 直近履歴を読み込み
  const history = await loadHistory(userId);

  // OpenAIに渡すメッセージ列
  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: text }];

  // 生成
  let replyText = "うまく返せなかった…もう一回言って！";
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages
    });
    replyText = completion.choices?.[0]?.message?.content?.slice(0, 2000) || replyText;
  } catch (e) {
    console.error("OpenAI error:", e);
    replyText = "サーバーがちょっと混んでるみたい…少しだけ待ってもう一度送ってみてね🥺";
  }

  // 履歴更新＆保存
  const newHistory = [...history, { role: "user", content: text }, { role: "assistant", content: replyText }];
  await saveHistory(userId, newHistory);

  // 返信
  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
}

/** ====== 起動 ====== */
const port = Number(PORT) || 3000;
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
