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
    twilio_number: twilioNumber || ""
  };

  const base44 = getBase44Client();
  if (!base44 || !twilioNumber) return fallback;

  try {
    let records = [];

    if (base44.entities?.Business?.filter) {
      records = await base44.entities.Business.filter({ twilio_number: twilioNumber }, "-updated_date", 1);
    } else if (base44.entities?.Business?.list) {
      const all = await base44.entities.Business.list("-updated_date", 100);
      records = all.filter((b) => cleanPhone(b.twilio_number) === cleanPhone(twilioNumber));
    }

    if (!records || records.length === 0) {
      console.log("No Base44 Business matched Twilio number, using fallback env profile", { twilioNumber });
      return fallback;
    }

    const business = records[0];
    console.log("Loaded Base44 Business profile", {
      businessName: business.business_name || business.name,
      twilioNumber: business.twilio_number
    });

    return {
      ...fallback,
      ...business,
      business_name: business.business_name || business.name || fallback.business_name,
      services_offered: business.services_offered || fallback.services_offered,
      hours: business.hours || business.business_hours || fallback.hours,
      booking_goal: business.booking_goal || business.booking_instructions || fallback.booking_goal,
      pricing_policy: business.pricing_policy || business.pricing_notes || fallback.pricing_policy,
      ai_instructions: business.ai_instructions || business.urgent_alert_rules || fallback.ai_instructions
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

app.get("/debug/base44", async (_req, res) => {
  try {
    const base44 = getBase44Client();
    if (!base44) return res.status(500).json({ ok: false, error: "Missing Base44 env vars" });

    const createdLead = await base44.entities.Lead.create({
      customer_name: "Render Base44 Test",
      customer_phone: "+16047005142",
      business_name: "Render Diagnostic",
      service_needed: "Diagnostic test lead created directly from Render",
      urgency: "medium",
      message_summary: "Render can create Base44 Lead records.",
      full_conversation: "system: /debug/base44 test endpoint was opened.",
      status: "new",
      source: "Render Diagnostic",
      notes: "Diagnostic test lead.",
      created_at: new Date().toISOString()
    });

    return res.json({ ok: true, createdLeadId: createdLead?.id || createdLead?._id || null });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
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

async function sendLeadToBase44({ from, history, parsed, initialMessage, business }) {
  const base44 = getBase44Client();
  if (!base44) {
    console.log("Base44 env vars missing, skipping Base44 lead push.");
    return;
  }

  const lead = parsed.lead || {};
  const payload = {
    customer_name: lead.customer_name || "Unknown",
    customer_phone: lead.customer_phone || from,
    business_name: lead.business_name || business?.business_name || business?.name || "",
    service_needed: lead.service_needed || initialMessage || "New SMS inquiry",
    urgency: normalizeUrgency(lead.urgency),
    message_summary: lead.message_summary || initialMessage || "New SMS inquiry received.",
    full_conversation: history.map((m) => `${m.role}: ${m.content}`).join("\n"),
    status: "new",
    source: "Twilio SMS LLM",
    notes: parsed.handoff_required ? "Handoff required" : "New inbound SMS - AI is still qualifying this lead",
    created_at: new Date().toISOString()
  };

  try {
    const createdLead = await base44.entities.Lead.create(payload);
    console.log("Base44 lead created successfully", { id: createdLead?.id || createdLead?._id || null });
  } catch (error) {
    console.error("Base44 lead create failed", error);
  }
}

function normalizeUrgency(value) {
  const urgency = String(value || "medium").toLowerCase();
  return ["low", "medium", "high", "emergency"].includes(urgency) ? urgency : "medium";
}

app.listen(PORT, () => {
  console.log(`SyncLead LLM webhook running on port ${PORT}`);
});
