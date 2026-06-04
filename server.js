import express from "express";
import OpenAI from "openai";
import { createClient } from "@base44/sdk";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;
const conversations = new Map();

function getBase44Client() {
  if (!process.env.BASE44_APP_ID || !process.env.BASE44_API_KEY) return null;
  return createClient({
    appId: process.env.BASE44_APP_ID,
    headers: { api_key: process.env.BASE44_API_KEY }
  });
}

function cleanPhone(value) {
  return String(value || "").replace(/[^0-9+]/g, "");
}

// Bare digits for matching two numbers regardless of formatting.
// "+1 (236) 205-2045" -> "2362052045"
function digitsOnly(value) {
  let d = String(value || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d;
}

// Canonical E.164 for storage. "2362052045" -> "+12362052045"
function toE164(value) {
  const d = digitsOnly(value);
  if (d.length === 10) return `+1${d}`;
  return value ? String(value).trim() : "";
}

function asText(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value || "";
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function respondToTwilio(req, res, reply) {
  const directTwilioWebhook = Boolean(req.body.From || req.body.Body || req.body.MessageSid);
  if (directTwilioWebhook) {
    res.set("Content-Type", "text/xml");
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
  }
  return res.json({ reply });
}

async function getBusinessProfile(twilioNumber) {
  const fallback = {
    business_name: process.env.CLIENT_BUSINESS_NAME || process.env.BUSINESS_NAME || "the business",
    industry: process.env.CLIENT_INDUSTRY || "local service business",
    service_area: process.env.CLIENT_SERVICE_AREA || "the local service area",
    services_offered: process.env.CLIENT_SERVICES || "the services offered by the business",
    hours: process.env.CLIENT_HOURS || "",
    booking_goal: process.env.CLIENT_BOOKING_GOAL || "collect enough information for the team to follow up and book the customer",
    pricing_policy: process.env.CLIENT_PRICING_POLICY || "Do not quote exact prices unless they are provided in the business profile.",
    required_lead_fields: "customer name, phone, service needed, location, urgency, preferred time",
    faqs: "",
    tone: process.env.CLIENT_TONE || "friendly, professional, helpful, and concise",
    ai_instructions: process.env.CLIENT_AI_INSTRUCTIONS || "",
    owner_email: "",
    twilio_number: twilioNumber || ""
  };

  const base44 = getBase44Client();
  if (!base44 || !twilioNumber) return fallback;

  try {
    let records = [];

    if (base44.entities?.Business?.filter) {
      records = await base44.entities.Business.filter({ twilio_number: twilioNumber }, "-updated_date", 1);
    }

    // If exact-match filter found nothing, fall back to a tolerant digits match
    // so stored format differences (dashes, spaces, missing +1) still resolve.
    if ((!records || records.length === 0) && base44.entities?.Business?.list) {
      const all = await base44.entities.Business.list("-updated_date", 100);
      records = all.filter((b) => digitsOnly(b.twilio_number) === digitsOnly(twilioNumber));
    }

    if (!records || records.length === 0) {
      console.log("No Base44 Business matched Twilio number, using fallback env profile", { twilioNumber });
      return fallback;
    }

    const business = records[0];
    console.log("Loaded Base44 Business profile", {
      businessName: business.business_name || business.name,
      twilioNumber: business.twilio_number,
      ownerEmail: business.owner_email
    });

    return {
      ...fallback,
      ...business,
      business_name: business.business_name || business.name || fallback.business_name,
      services_offered: business.services_offered || fallback.services_offered,
      hours: business.hours || business.business_hours || fallback.hours,
      booking_goal: business.booking_goal || business.booking_instructions || fallback.booking_goal,
      pricing_policy: business.pricing_policy || business.pricing_notes || fallback.pricing_policy,
      ai_instructions: business.ai_instructions || business.urgent_alert_rules || fallback.ai_instructions,
      // tenant routing + access control fields
      owner_email: business.owner_email || fallback.owner_email,
      twilio_number: toE164(business.twilio_number || twilioNumber)
    };
  } catch (error) {
    console.error("Failed to load Base44 Business profile, using fallback env profile", {
      message: error?.message,
      status: error?.status
    });
    return fallback;
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/debug/env", (_req, res) => {
  res.json({
    ok: true,
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasBase44AppId: Boolean(process.env.BASE44_APP_ID),
    hasBase44ApiKey: Boolean(process.env.BASE44_API_KEY),
    clientBusinessName: process.env.CLIENT_BUSINESS_NAME || process.env.BUSINESS_NAME || null
  });
});

app.get("/debug/business", async (req, res) => {
  const twilioNumber = req.query.to || process.env.CLIENT_TWILIO_NUMBER || "+12362052045";
  const business = await getBusinessProfile(twilioNumber);
  res.json({ ok: true, twilioNumber, business });
});

app.post("/twilio/sms", async (req, res) => {
  try {
    const from = req.body.From || req.body.from;
    const to = req.body.To || req.body.to;
    const body = req.body.Body || req.body.body || "";

    console.log("Inbound SMS received", {
      from,
      to,
      bodyPreview: body.slice(0, 120),
      hasBase44AppId: Boolean(process.env.BASE44_APP_ID),
      hasBase44ApiKey: Boolean(process.env.BASE44_API_KEY)
    });

    if (!from || !body) {
      return respondToTwilio(req, res, "Sorry, I could not read that message.");
    }

    const business = await getBusinessProfile(to);
    const businessName = business.business_name || "the business";
    const industry = business.industry || "local service business";
    const serviceArea = business.service_area || "the local service area";
    const services = asText(business.services_offered);
    const hours = asText(business.hours);
    const bookingGoal = asText(business.booking_goal);
    const tone = asText(business.tone);
    const pricingPolicy = asText(business.pricing_policy);
    const requiredLeadFields = asText(business.required_lead_fields);
    const faqs = asText(business.faqs);
    const extraInstructions = asText(business.ai_instructions);

    const conversationKey = `${to}:${from}`;
    const history = conversations.get(conversationKey) || [];
    history.push({ role: "customer", content: body });

    const systemPrompt = `
You are the SMS assistant for ${businessName}, a ${industry}.

You are talking to customers who text ${businessName} for help, service, quotes, bookings, or questions.

Business profile from the live Base44 app:
- Business name: ${businessName}
- Industry: ${industry}
- Service area: ${serviceArea}
- Services offered: ${services}
- Hours: ${hours}
- Booking goal: ${bookingGoal}
- Tone: ${tone}
- Pricing policy: ${pricingPolicy}
- Required lead fields: ${requiredLeadFields}
- FAQs: ${faqs}
- Custom assistant instructions: ${extraInstructions}

Rules:
- Keep replies short because this is SMS.
- Ask one question at a time.
- Sound like a real helpful front-desk person, not a robot.
- Do not say you are an AI unless asked directly.
- Never quote exact prices or appointment availability unless the Base44 profile explicitly provides it.
- Use the business profile above as the source of truth.
- If the customer asks for a human, pricing not covered in the profile, complaint handling, cancellation, or emergency help, mark handoff_required true.

Return ONLY valid JSON in this exact shape:
{
  "reply": "text message reply to customer",
  "lead": {
    "customer_name": null,
    "customer_phone": null,
    "business_name": "${businessName}",
    "service_needed": null,
    "urgency": "low | medium | high | emergency",
    "preferred_time": null,
    "message_summary": null
  },
  "missing_fields": [],
  "lead_ready": false,
  "handoff_required": false
}
`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({ customer_phone: from, latest_message: body, conversation_history: history })
        }
      ],
      temperature: 0.4,
      response_format: { type: "json_object" }
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const reply = parsed.reply || "Thanks — can you tell me a bit more about what you need help with?";

    history.push({ role: "assistant", content: reply });
    conversations.set(conversationKey, history.slice(-20));

    await sendLeadToBase44({ from, history, parsed, initialMessage: body, business });

    return respondToTwilio(req, res, reply);
  } catch (error) {
    console.error("SMS webhook error:", error);
    return respondToTwilio(req, res, "Thanks for reaching out — what can we help with today, and what city are you located in?");
  }
});

// Find the existing open lead for this conversation (same business number + same
// customer phone), so we UPDATE one record per chat instead of creating a new
// lead on every inbound text. Only "open" statuses are reused; a closed lead
// (booked/lost/spam) won't be reopened — a genuinely new inquiry starts fresh.
const OPEN_STATUSES = ["new", "contacted"];

// How long an open lead counts as "the same conversation". A new inbound text
// from the same customer AFTER this window starts a FRESH lead instead of
// reopening the old one — so a repeat customer (new job weeks/months later)
// becomes a new lead instead of overwriting their previous one. Tune via env
// (DEDUP_WINDOW_HOURS) with no code change. 48h default suits trades with
// multi-day back-and-forth (text Monday, reply Thursday still = one job).
const DEDUP_WINDOW_HOURS = Number(process.env.DEDUP_WINDOW_HOURS || 48);
const DEDUP_WINDOW_MS = DEDUP_WINDOW_HOURS * 60 * 60 * 1000;

async function findExistingLead(base44, twilioNumber, customerPhone) {
  if (!twilioNumber || !customerPhone) return null;
  try {
    let candidates = [];
    if (base44.entities?.Lead?.filter) {
      candidates = await base44.entities.Lead.filter(
        { twilio_number: twilioNumber, customer_phone: customerPhone },
        "-updated_date",
        10
      );
    } else if (base44.entities?.Lead?.list) {
      const all = await base44.entities.Lead.list("-updated_date", 100);
      candidates = all.filter(
        (l) =>
          digitsOnly(l.twilio_number) === digitsOnly(twilioNumber) &&
          digitsOnly(l.customer_phone) === digitsOnly(customerPhone)
      );
    }

    // Only still-open leads can be reused.
    const openCandidates = candidates.filter((l) =>
      OPEN_STATUSES.includes(String(l.status || "new").toLowerCase())
    );
    if (openCandidates.length === 0) return null;

    // Pick the genuinely most-recently-active open lead (don't trust list order).
    openCandidates.sort(
      (a, b) =>
        new Date(b.updated_date || b.created_date || 0) -
        new Date(a.updated_date || a.created_date || 0)
    );
    const mostRecent = openCandidates[0];

    // The window decision: recent activity = same conversation, so update it.
    // Stale = treat this text as a new job and force a fresh lead (return null).
    const lastActivity = new Date(
      mostRecent.updated_date || mostRecent.created_date || 0
    ).getTime();

    if (Date.now() - lastActivity >= DEDUP_WINDOW_MS) {
      console.log("Most recent open lead is older than dedup window — creating a NEW lead", {
        twilio_number: twilioNumber,
        customer_phone: customerPhone,
        last_activity: mostRecent.updated_date || mostRecent.created_date,
        window_hours: DEDUP_WINDOW_HOURS
      });
      return null;
    }

    return mostRecent;
  } catch (error) {
    console.error("findExistingLead failed, will create a new lead instead", { message: error?.message });
    return null;
  }
}

// Text the business owner when a NEW lead comes in. Uses Twilio's REST API
// directly via fetch (no extra dependency). Reads credentials from Render env.
// Wrapped so any failure here NEVER blocks the lead from being saved.
async function notifyOwnerOfNewLead({ business, lead, customerPhone, twilioNumber }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const ownerPhone = business?.owner_phone;

  if (!sid || !token) {
    console.log("Owner SMS alert skipped: Twilio credentials not set in env.");
    return;
  }
  if (!ownerPhone) {
    console.log("Owner SMS alert skipped: business has no owner_phone.", {
      business_name: business?.business_name
    });
    return;
  }
  if (!twilioNumber) {
    console.log("Owner SMS alert skipped: no twilio_number to send from.");
    return;
  }

  const service = lead.service_needed || lead.message_summary || "new inquiry";
  const bizName = business?.business_name || "your business";
  const body = `New lead for ${bizName}. ${service}. From ${customerPhone}. Open your app to view and reply.`;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const params = new URLSearchParams({ To: ownerPhone, From: twilioNumber, Body: body });
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Owner SMS alert failed (lead still saved)", { status: resp.status, errText });
      return;
    }
    console.log("Owner SMS alert sent", { to: ownerPhone, business_name: bizName });
  } catch (error) {
    // A notification failure must NEVER block or break the lead write.
    console.error("Owner SMS alert threw (lead still saved)", { message: error?.message });
  }
}

async function sendLeadToBase44({ from, history, parsed, initialMessage, business }) {
  const base44 = getBase44Client();
  if (!base44) {
    console.log("Base44 env vars missing, skipping Base44 lead push.");
    return;
  }

  const lead = parsed.lead || {};
  const ownerEmail = business?.owner_email || "";
  const twilioNumber = business?.twilio_number || "";
  const customerPhone = lead.customer_phone || from;
  const fullConversation = history.map((m) => `${m.role}: ${m.content}`).join("\n");

  if (!ownerEmail) {
    console.warn("Lead has no owner_email — the Business for this Twilio number is missing owner_email in Base44. Lead will not be visible until that business has an owner_email set.", {
      twilio_number: twilioNumber,
      business_name: lead.business_name || business?.business_name
    });
  }

  // Fields that should refresh as the conversation develops.
  const updatable = {
    customer_name: lead.customer_name || undefined,
    business_name: lead.business_name || business?.business_name || business?.name || "",
    owner_email: ownerEmail,
    twilio_number: twilioNumber,
    service_needed: lead.service_needed || undefined,
    urgency: normalizeUrgency(lead.urgency),
    message_summary: lead.message_summary || initialMessage || "New SMS inquiry received.",
    full_conversation: fullConversation,
    source: "Twilio SMS LLM",
    notes: parsed.handoff_required ? "Handoff required" : "New inbound SMS - AI is still qualifying this lead"
  };
  // Strip undefined so we never overwrite a known value with a blank.
  Object.keys(updatable).forEach((k) => updatable[k] === undefined && delete updatable[k]);

  try {
    const existing = await findExistingLead(base44, twilioNumber, customerPhone);

    if (existing) {
      const id = existing.id || existing._id;
      const updated = await base44.entities.Lead.update(id, updatable);
      console.log("Base44 lead UPDATED (one lead per conversation)", {
        id,
        owner_email: ownerEmail,
        twilio_number: twilioNumber
      });
      return updated;
    }

    const createdLead = await base44.entities.Lead.create({
      ...updatable,
      customer_name: updatable.customer_name || "Unknown",
      customer_phone: customerPhone,
      service_needed: updatable.service_needed || initialMessage || "New SMS inquiry",
      status: "new",
      created_at: new Date().toISOString()
    });
    console.log("Base44 lead CREATED (new conversation)", {
      id: createdLead?.id || createdLead?._id || null,
      owner_email: ownerEmail,
      twilio_number: twilioNumber
    });

    // Fire the owner alert ONLY for newly created leads (not updates), so the
    // owner gets one text per new conversation, not on every back-and-forth.
    await notifyOwnerOfNewLead({ business, lead, customerPhone, twilioNumber });

    return createdLead;
  } catch (error) {
    console.error("Base44 lead upsert failed", error);
  }
}

function normalizeUrgency(value) {
  const urgency = String(value || "medium").toLowerCase();
  return ["low", "medium", "high", "emergency"].includes(urgency) ? urgency : "medium";
}

app.listen(PORT, () => {
  console.log(`SyncLead LLM webhook running on port ${PORT}`);
});
