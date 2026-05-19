// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { sendEmail } from "../email-sender";
import { storeAttachments } from "../lib/attachments";
import type { EmailFull } from "../lib/schemas";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
	resolveOriginalEmail,
} from "../lib/email-helpers";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import type { MailboxContext } from "../lib/mailbox";
import {
	incomingTranslationToStoredBody,
	isChineseLanguage,
	translateIncomingEmail,
	translateReplyForPreview,
	type ReplyTranslationPreview,
} from "../lib/openai-translation";

type AppContext = Context<MailboxContext>;
type MailboxStub = MailboxContext["Variables"]["mailboxStub"];
type RateLimitStub = { checkSendRateLimit: () => Promise<string | null> };
type TranslationUpdateStub = {
	updateEmailTranslation: (
		id: string,
		translation: Record<string, string | null>,
	) => Promise<EmailFull | null>;
};

async function ensureOriginalLanguage(
	c: AppContext,
	stub: MailboxStub,
	originalEmail: EmailFull,
): Promise<{ language: string; languageName: string }> {
	if (originalEmail.source_language) {
		return {
			language: originalEmail.source_language,
			languageName: originalEmail.source_language_name || originalEmail.source_language,
		};
	}

	if (!c.env.OPENAI_API_KEY) {
		throw new Error("OPENAI_API_KEY is not configured");
	}

	const translation = await translateIncomingEmail(c.env, {
		subject: originalEmail.subject,
		body: originalEmail.body,
	});

	await (stub as unknown as TranslationUpdateStub).updateEmailTranslation(
		originalEmail.id,
		{
			source_language: translation.sourceLanguage,
			source_language_name: translation.sourceLanguageName,
			translated_subject_zh: translation.translatedSubjectZh,
			translated_body_zh: incomingTranslationToStoredBody(translation),
			summary_zh: null,
			translation_status: "done",
		},
	);

	return {
		language: translation.sourceLanguage,
		languageName: translation.sourceLanguageName,
	};
}

async function resolveReplyBodyForRecipientLanguage(
	c: AppContext,
	stub: MailboxStub,
	originalEmail: EmailFull,
	input: {
		html?: string;
		text?: string;
		translationPreview?: ReplyTranslationPreview;
	},
): Promise<{
	html?: string;
	text?: string;
	replyBodyZh?: string | null;
	targetLanguage?: string | null;
	targetLanguageName?: string | null;
}> {
	const target = await ensureOriginalLanguage(c, stub, originalEmail);
	if (!target.language || isChineseLanguage(target.language, target.languageName)) {
		return { html: input.html, text: input.text };
	}

	const matchingPreview =
		input.translationPreview?.translationRequired &&
		input.translationPreview.targetLanguage.toLowerCase() === target.language.toLowerCase()
			? input.translationPreview
			: null;

	const preview = matchingPreview ?? await translateReplyForPreview(c.env, {
		html: input.html,
		text: input.text,
		targetLanguage: target.language,
		targetLanguageName: target.languageName,
	});

	return {
		html: preview.translatedHtml,
		text: preview.translatedText,
		replyBodyZh: preview.originalHtmlZh || input.html || input.text || null,
		targetLanguage: preview.targetLanguage,
		targetLanguageName: preview.targetLanguageName,
	};
}

export async function handleReplyTranslationPreview(c: AppContext) {
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { html, text } = body;
	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	const originalEmail = await resolveOriginalEmail(stub, rawOriginal);

	try {
		const target = await ensureOriginalLanguage(c, stub, originalEmail);
		const preview = await translateReplyForPreview(c.env, {
			html,
			text,
			targetLanguage: target.language,
			targetLanguageName: target.languageName,
		});
		return c.json(preview);
	} catch (e) {
		return c.json({ error: (e as Error).message }, 500);
	}
}

export async function handleReplyEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, translationPreview } = body;

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	const originalEmail = await resolveOriginalEmail(stub, rawOriginal);
	const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	let translatedReply: Awaited<ReturnType<typeof resolveReplyBodyForRecipientLanguage>>;
	try {
		translatedReply = await resolveReplyBodyForRecipientLanguage(
			c,
			stub,
			originalEmail,
			{ html, text, translationPreview },
		);
	} catch (e) {
		return c.json({ error: (e as Error).message }, 500);
	}
	const outgoingHtml = translatedReply.html ?? html;
	const outgoingText = translatedReply.text ?? text;
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: outgoingHtml || outgoingText || "",
			in_reply_to: originalMsgId,
			email_references: JSON.stringify(references),
			thread_id: thread_id,
			message_id: outgoingMessageId,
			reply_body_zh: translatedReply.replyBodyZh ?? null,
			target_language: translatedReply.targetLanguage ?? null,
			target_language_name: translatedReply.targetLanguageName ?? null,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
				...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
				...(references.length > 0 ? [{ key: "references", value: references.map((r: string) => `<${r}>`).join(" ") }] : []),
			]),
		},
		attachmentData,
	);

	await stub.markThreadRead(thread_id);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to,
			cc,
			bcc,
			from,
			subject,
			html: outgoingHtml,
			text: outgoingText,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
			headers: buildThreadingHeaders(originalMsgId, references),
		}).catch((e) => {
			console.error("Deferred reply delivery failed:", (e as Error).message);
		}),
	);

	return c.json({ id: messageId, status: "sent" }, 202);
}

export async function handleForwardEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	await resolveOriginalEmail(stub, rawOriginal);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: html || text || "",
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
			]),
		},
		attachmentData,
	);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
		}).catch((e) => {
			console.error("Deferred forward delivery failed:", (e as Error).message);
		}),
	);

	return c.json({ id: messageId, status: "sent" }, 202);
}
