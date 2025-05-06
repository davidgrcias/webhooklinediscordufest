// index.js
console.log("🔥 Starting index.js…");

const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const axios = require("axios");
const FormData = require("form-data");

// ─── CONFIGURATION ────────────────────────────────────────────────
const LINE_CHANNEL_SECRET =
  process.env.LINE_CHANNEL_SECRET || "e427cfcf924c9f724ebf4aae8995dd95";
const LINE_CHANNEL_TOKEN =
  process.env.LINE_CHANNEL_TOKEN ||
  "HpyhrLNHlnfOfJHgtPnguwn79cpgfB4Ad1W/75NkL72soa28EUyAFfP9aEpWpdvN4m3GmSsYSjvR1ILaRsn/f+nDV4ZDWEHemxNkyM2xlPPExMk6peKBXfm+6Z/TNb9IFknwXI/zA4xzFBCoP5+5CgdB04t89/1O/w1cDnyilFU=";
const LINE_GROUP_ID =
  process.env.LINE_GROUP_ID || "C844da05c08cb0edb188e321d15e46a9b";
const DISCORD_WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1368830015881347083/RkuAxqV4A2ABNtv0HI2CW4FN3Y7n5hL6XPutmp8bkKaI7kWFO_RFEWlICFyygjpcbJ4C";
// ───────────────────────────────────────────────────────────────────

// Deduplication set
const processedMessageIds = new Set();

const lineConfig = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_TOKEN,
};
const lineClient = new line.Client(lineConfig);
const app = express();

// 1) parse JSON with raw body
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
// 2) LINE signature validation
app.use(line.middleware(lineConfig));

// webhook endpoint
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  console.log(`📬 Received ${events.length} events`);
  try {
    for (const event of events) {
      await handleLineEvent(event);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Processing error:", err);
    res.sendStatus(500);
  }
});

async function handleLineEvent(event) {
  // Deduplication
  const msgId = event.message?.id;
  if (msgId) {
    if (processedMessageIds.has(msgId)) {
      console.log(`🔁 Duplicate event ${msgId}, skipping`);
      return;
    }
    processedMessageIds.add(msgId);
  }

  // Only group
  if (event.source.type !== "group" || event.source.groupId !== LINE_GROUP_ID)
    return;

  // send helper
  const sendDiscord = async (
    data,
    headers = { "Content-Type": "application/json" }
  ) => {
    try {
      const resp = await axios.post(DISCORD_WEBHOOK_URL, data, { headers });
      console.log("✅ Discord responded:", resp.status);
    } catch (err) {
      console.error("❌ Discord error:", err.response?.data || err.message);
    }
  };

  // 1) MEDIA first
  if (
    event.type === "message" &&
    ["image", "video", "file"].includes(event.message.type)
  ) {
    const id = event.message.id;
    const stream = await lineClient.getMessageContent(id);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const buffer = Buffer.concat(chunks);
    const form = new FormData();
    let filename, contentType;
    if (event.message.type === "file") {
      filename = event.message.fileName;
      contentType =
        event.message.contentProvider?.contentType ||
        "application/octet-stream";
    } else if (event.message.type === "video") {
      filename = `${id}.mp4`;
      contentType = "video/mp4";
    } else {
      filename = `${id}.jpg`;
      contentType = "image/jpeg";
    }
    form.append("file", buffer, { filename, contentType });
    form.append(
      "payload_json",
      JSON.stringify({
        content: "@everyone",
        allowed_mentions: { parse: ["everyone"] },
      })
    );
    await sendDiscord(form, form.getHeaders());
    return;
  }

  // 2) TEXT and structured
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text;

    // a) Freeform content before structured block
    const freeMatch = text.match(/^([\s\S]*?)(?=\s*1\.\s*Tags\s*:)/i);
    if (freeMatch) {
      const freeform = freeMatch[1].trim();
      if (freeform) {
        await sendDiscord({
          content: freeform,
          allowed_mentions: { parse: ["everyone"] },
        });
      }
    }

    // b) Tags
    const tags = (text.match(/Tags\s*:\s*\[([\s\S]*?)\]/i)?.[1] || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/^-+\s*/, "").trim())
      .filter(Boolean);
    for (const t of tags)
      await sendDiscord({
        content: t,
        allowed_mentions: { parse: ["everyone"] },
      });

    // c) Hashtags
    const hsBlock = text.match(/Hastags\s*:\s*\[([\s\S]*?)\]/i)?.[1] || "";
    const hashtags = hsBlock
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
    if (hashtags)
      await sendDiscord({
        content: hashtags,
        allowed_mentions: { parse: ["everyone"] },
      });

    // d) Links
    const links = (text.match(/Link\s*:\s*\[([\s\S]*?)\]/i)?.[1] || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const u of links)
      await sendDiscord({
        content: u,
        allowed_mentions: { parse: ["everyone"] },
      });

    // e) Caption
    let capText = "";
    const capB = text.match(/Caption\s*:\s*\[([\s\S]*?)\]/i);
    if (capB) capText = capB[1];
    else {
      const capD = text.match(/Caption\s*:\s*(?:\r?\n)?([\s\S]*)$/i);
      if (capD) capText = capD[1];
    }
    if (capText) {
      const caps = capText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
      await sendDiscord({
        content: caps,
        allowed_mentions: { parse: ["everyone"] },
      });
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
