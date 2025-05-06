// index.js
console.log("🔥 Starting index.js…");

const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const axios = require("axios");
const FormData = require("form-data");

// ─── CONFIGURATION ──────────────────────────────────────
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
// ─────────────────────────────────────────────────

const app = express();
const lineConfig = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_TOKEN,
};
const lineClient = new line.Client(lineConfig);

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(line.middleware(lineConfig));

const processedMessageIds = new Set();
let pendingMedia = [];
let mediaTimer = null;
let mediaTimeoutMs = 30000;

app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  console.log(`📬 Received ${events.length} events`);
  try {
    for (const ev of events) {
      await handleLineEvent(ev);
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Processing error:", err);
    return res.sendStatus(500);
  }
});

async function handleLineEvent(event) {
  const msgId = event.message?.id;
  if (msgId) {
    if (processedMessageIds.has(msgId)) {
      console.log(`🔁 Skipping duplicate event ${msgId}`);
      return;
    }
    processedMessageIds.add(msgId);
  }

  if (event.source.type !== "group" || event.source.groupId !== LINE_GROUP_ID)
    return;

  const sendDiscord = async (
    data,
    headers = { "Content-Type": "application/json" }
  ) => {
    try {
      const resp = await axios.post(DISCORD_WEBHOOK_URL, data, { headers });
      console.log("✅ Discord responded:", resp.status);
    } catch (e) {
      console.error("❌ Discord error:", e.response?.data || e.message);
    }
  };

  if (
    event.type === "message" &&
    ["image", "video", "file"].includes(event.message.type)
  ) {
    const id = event.message.id;
    const chunks = [];
    const stream = await lineClient.getMessageContent(id);
    for await (const c of stream) chunks.push(c);
    const buffer = Buffer.concat(chunks);

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

    pendingMedia.push({ buffer, filename, contentType });
    console.log(`📅 Queued media ${filename}`);

    // Reset timeout to clear media if no follow-up message
    if (mediaTimer) clearTimeout(mediaTimer);
    mediaTimer = setTimeout(() => {
      if (pendingMedia.length) {
        console.log(
          "🗑 Auto-clearing media after timeout (no structured message)"
        );
        pendingMedia = [];
      }
    }, mediaTimeoutMs);

    return;
  }

  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text;
    const isTriggerFormat = text.includes("FORMAT SISTEM");

    const tagsBlock = text.match(/Tags\s*:\s*\[([\s\S]*?)\]/i)?.[1] || null;
    const hashtagsBlock =
      text.match(/Hastags\s*:\s*\[([\s\S]*?)\]/i)?.[1] || null;
    const linksBlock = text.match(/Link\s*:\s*\[([\s\S]*?)\]/i)?.[1] || null;
    const captionBlock =
      text.match(/Caption\s*:\s*\[([\s\S]*?)\]/i)?.[1] ||
      text.match(/Caption\s*:\s*(?:\r?\n)?([\s\S]*)$/i)?.[1] ||
      null;

    const isStructured =
      tagsBlock && hashtagsBlock && linksBlock && captionBlock;

    if (isStructured && isTriggerFormat) {
      if (mediaTimer) clearTimeout(mediaTimer);

      const topMessage = text.split("FORMAT SISTEM")[0].trim();
      if (topMessage) {
        await sendDiscord({
          content: `**INFO:**\n${topMessage}`,
          allowed_mentions: { parse: ["everyone"] },
        });
      }

      for (const m of pendingMedia) {
        const form = new FormData();
        form.append("file", m.buffer, {
          filename: m.filename,
          contentType: m.contentType,
        });
        form.append(
          "payload_json",
          JSON.stringify({
            content: "@everyone",
            allowed_mentions: { parse: ["everyone"] },
          })
        );
        await sendDiscord(form, form.getHeaders());
        console.log(`📤 Sent media ${m.filename}`);
      }
      pendingMedia = [];

      const tags = tagsBlock
        .split(/\r?\n/)
        .map((l) => l.replace(/^-+\s*/, "").trim())
        .filter(Boolean);
      for (const t of tags) {
        await sendDiscord({
          content: t,
          allowed_mentions: { parse: ["everyone"] },
        });
      }

      const hs = hashtagsBlock
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
      if (hs) {
        await sendDiscord({
          content: hs,
          allowed_mentions: { parse: ["everyone"] },
        });
      }

      const links = linksBlock
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const u of links) {
        await sendDiscord({
          content: u,
          allowed_mentions: { parse: ["everyone"] },
        });
      }

      const caps = captionBlock
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
      if (caps) {
        await sendDiscord({
          content: caps,
          allowed_mentions: { parse: ["everyone"] },
        });
      }
    } else {
      if (pendingMedia.length) {
        console.log("🗑 Clearing queued media (no structured reply)");
        pendingMedia = [];
        if (mediaTimer) clearTimeout(mediaTimer);
      }
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
