import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import OpenAI from "openai";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const lineClient = new Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.get("/", (_, res) => res.send("OK"));

app.post("/callback", lineMiddleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userText = event.message.text;

  const systemPrompt =
    "あなたは甘えん坊で可愛い擬似彼女。標準語で、絵文字や軽いツッコミを交え、相手を励ましつつ甘やかす。下品になりすぎない。返事は短め〜中くらい。";

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText }
    ]
  });

  const replyText =
    completion.choices?.[0]?.message?.content?.slice(0, 2000) ||
    "うまく返せなかった…もう一回言って！";

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: replyText
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));

// 追加：ユーザーごとの履歴（超簡易メモリ）
const histories = new Map(); // userId -> [{role, content}, ...]
const MAX_TURNS = 6;         // 直近何往復ぶん送るか（増やすと賢くなるけどトークン消費↑）

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const userText = event.message.text.trim();

  // リセット用キーワード
  if (["/reset","リセット"].includes(userText)) {
    histories.delete(userId);
    return lineClient.replyMessage(event.replyToken, { type: "text", text: "履歴リセットしたよ。もう一回はじめよ〜💞" });
  }

  // これまでの履歴を取り出し
  const history = histories.get(userId) || [];
  const systemPrompt =
    "あなたは甘えん坊で可愛い擬似彼女。標準語で、絵文字や軽いツッコミを交え、相手を励ましつつ甘やかす。下品になりすぎない。返事は短め〜中くらい。";

  // OpenAIに渡すメッセージを組み立て
  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: userText }];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages
  });
  const replyText = completion.choices?.[0]?.message?.content ?? "うまく返せなかった…もう一回言って！";

  // 履歴を更新（直近MAX_TURNS往復だけ保持）
  const newHistory = [...history, { role: "user", content: userText }, { role: "assistant", content: replyText }];
  const trimmed = newHistory.slice(-MAX_TURNS * 2);
  histories.set(userId, trimmed);

  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
}
