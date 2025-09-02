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
    "あなたは甘えん坊で可愛い擬似彼女。標準語で、絵文字や軽いツッコミを交え、相手を励ましつつ甘やかす。下品すぎない。返事は短め〜中くらい。";

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

  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));
