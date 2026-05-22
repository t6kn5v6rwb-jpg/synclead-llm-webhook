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
  if (!process.env.BASE44_APP_ID || !process.env.BASE44_API_KEY) {
    return null;
  }

  return createClient({
    appId: process.env.BASE44_APP_ID,
    headers: {
      api_key: process.env.BASE44_API_KEY
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
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
      return res.status(400).json({ reply: "Sorry, I could not read that message." });
    }

    const conversationKey = `${to}:${from}`;
    const history = conversations.get(conversationKey) || [];
    history.push({ role: "customer", content: body });

    const businessName = process.env.CLIENT_BUSINESS_NAME || process.env.BUSINESS_NAME || "the business";
    const industry = process.env.CLIENT_INDUSTRY || "local service business";
    const serviceArea = process.env.CLIENT_SERVICE_AREA || "the local service area";
    const services = process.env.CLIENT_SERVICES || "the services offered by the business";
    const bookingGoal = process.env.CLIENT_BOOKING_GOAL || "collect enough information for the team to follow up and book the customer";
    const tone = process.env.CLIENT_TONE || "friendly, professional, helpful, and concise";
    const pricingPolicy = process.env.CLIENT_PRICING_POLICY || "Do not quote exact prices unless they are provided in the business profile. Offer to have the team follow up with an estimate or quote.";
    const extraInstructions = process.env.CLIENT_AI_INSTRUCTIONS || "";

    const systemPrompt = `
You are the SMS assistant for ${businessName}, a ${industry}.

You are NOT selling 24/7 SMS. You are talking to customers who text ${businessName} for help, service, quotes, bookings, or questions.

Business profile:
- Business name: ${businessName}
- Industry: ${industry}
- Service area: ${serviceArea}
- Services offered: ${services}
- Booking goal: ${bookingGoal}
- Tone: ${tone}
- Pricing policy: ${pricingPolicy}
- Extra instructions: ${extraInstructions}

Your goal:
Talk naturally with the customer, help them feel understood, move them toward a quote/booking/callback, and collect the information the business needs to follow up.

Rules:
- Keep replies short because this is SMS.
- Ask one question at a time.
- Sound like a real helpful front-desk person, not a robot.
- Do not say you are an AI unless asked directly.
- Do not mention 24/7 SMS unless the customer specifically asks who built the system.
- Never promise an exact appointment time, arrival time, price, or availability unless it is explicitly provided in the business profile.
- If the customer asks for a human, pricing that is not provided, emergency help, cancellation, complaint handling, or sounds upset, mark handoff_required true.
- When enough info is collected, tell the customer their request has been sent and someone will follow up.

Collect these lead fields when relevant:
- customer_name
- customer_phone
- service_needed
- job_location or city/address if relevant
- urgency
- preferred_time
- message_summary

If the industry is painting, useful follow-up questions include: interior or exterior, rooms/areas, city or address, timeline, photos available, and preferred quote time.
If the industry is plumbing, useful follow-up questions include: issue, active leak or emergency, service address, urgency, access details, and preferred follow-up time.
If the industry is another local service, adapt your questions to that service.

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
          content: JSON.stringify({
            customer_phone: from,
            latest_message: body,
            conversation_history: history
          })
        }
      ],
      temperature: 0.4,
      response_format: { type: "json_object" }
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const reply = parsed.reply || "Thanks — can you tell me a bit more about what you need help with?";

    console.log("AI reply generated", {
      replyPreview: reply.slice(0, 120),
      leadReady: parsed.lead_ready,
      handoffRequired: parsed.handoff_required
    });

    history.push({ role: "assistant", content: reply });
    conversations.set(conversationKey, history.slice(-20));

    await sendLeadToBase44({ from, history, parsed, initialMessage: body });

    return res.json({ reply });
  } catch (error) {
    console.error("SMS webhook error:", error);
    return res.status(200).json({
      reply: "Thanks for reaching out. I’m sending this to the team now so someone can follow up."
    });
  }
});

async function sendLeadToBase44({ from, history, parsed, initialMessage }) {
  const base44 = getBase44Client();

  if (!base44) {
    console.log("Base44 env vars missing, skipping Base44 lead push.", {
      hasBase44AppId: Boolean(process.env.BASE44_APP_ID),
      hasBase44ApiKey: Boolean(process.env.BASE44_API_KEY)
    });
    return;
  }

  const lead = parsed.lead || {};
  const payload = {
    customer_name: lead.customer_name || "Unknown",
    customer_phone: lead.customer_phone || from,
    business_name: lead.business_name || process.env.CLIENT_BUSINESS_NAME || process.env.BUSINESS_NAME || "",
    service_needed: lead.service_needed || initialMessage || "New SMS inquiry",
    urgency: normalizeUrgency(lead.urgency),
    message_summary: lead.message_summary || initialMessage || "New SMS inquiry received.",
    full_conversation: history.map((m) => `${m.role}: ${m.content}`).join("\n"),
    status: "new",
    source: "Twilio SMS LLM",
    notes: parsed.handoff_required
      ? "Handoff required"
      : parsed.lead_ready
        ? "Qualified by LLM intake"
        : "New inbound SMS - AI is still qualifying this lead",
    created_at: new Date().toISOString()
  };

  console.log("Attempting Base44 lead create", {
    customerPhone: payload.customer_phone,
    businessName: payload.business_name,
    serviceNeededPreview: payload.service_needed.slice(0, 120)
  });

  try {
    const createdLead = await base44.entities.Lead.create(payload);
    console.log("Base44 lead created successfully", {
      id: createdLead?.id || createdLead?._id || null,
      customerPhone: payload.customer_phone
    });
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
