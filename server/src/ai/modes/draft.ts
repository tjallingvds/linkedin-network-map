/**
 * Draft mode — writes personalized email + LinkedIn DM for each recipient.
 */
import type { AiProvider, CompletionResult, OutreachDraft, Prospect } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";

export async function runDraft(
  provider: AiProvider,
  userInput: string,
  recipients: Prospect[],
  userId: string,
): Promise<CompletionResult> {
  if (recipients.length === 0) {
    return { kind: "text", content: "Select at least one prospect before drafting outreach." };
  }
  assertKeys(provider);

  const result = await aiJson<{ drafts: OutreachDraft[] }>(
    provider,
    "You write short, personal outreach messages. Reference one specific recent signal per recipient. No generic filler.",
    `Sender context: ${userInput || "I help engineering leaders ship faster."}\n\nRecipients:\n${JSON.stringify(
      recipients.map((p) => ({
        id: p.id,
        name: p.name,
        title: p.title,
        company: p.company,
        signals: p.signals,
        past: p.past.slice(0, 2),
      })),
    )}\n\nReturn {"drafts": [...]} one entry per recipient. Each: {recipientId, recipientName, recipientCompany, email: {subject, body}, linkedin}.\nEmail body: 3–4 sentences, plain text with line breaks, signed "— [sender]".\nLinkedIn: 1–2 sentences, under 280 chars.`,
    { maxTokens: 2500, userId },
  );

  return { kind: "drafts", drafts: result.drafts ?? [] };
}

function assertKeys(provider: AiProvider) {
  const ok =
    provider === "openai" ? !!env.OPENAI_API_KEY :
    provider === "anthropic" ? !!env.ANTHROPIC_API_KEY :
    !!env.DEEPSEEK_API_KEY;
  if (!ok) throw new Error(`${provider.toUpperCase()}_API_KEY not set — configure it in server .env.`);
}
