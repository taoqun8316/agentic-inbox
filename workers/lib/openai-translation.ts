// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { stripHtmlToText, textToHtml } from "./email-helpers";
import type { Env } from "../types";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_TRANSLATION_MODEL = "gpt-5.4-mini";
const MAX_TRANSLATION_INPUT_CHARS = 24_000;

interface OpenAIResponseJson {
	output_text?: string;
	output?: Array<{
		content?: Array<{
			type?: string;
			text?: string;
		}>;
	}>;
}

export interface IncomingEmailTranslation {
	sourceLanguage: string;
	sourceLanguageName: string;
	translatedSubjectZh: string;
	translatedBodyZh: string;
}

export interface ReplyTranslationPreview {
	translationRequired: boolean;
	targetLanguage: string;
	targetLanguageName: string;
	originalHtmlZh: string;
	originalTextZh: string;
	translatedHtml: string;
	translatedText: string;
}

function getOpenAIKey(env: Env): string {
	const key = env.OPENAI_API_KEY?.trim();
	if (!key) throw new Error("OPENAI_API_KEY is not configured");
	return key;
}

function getTranslationModel(env: Env): string {
	return env.OPENAI_TRANSLATION_MODEL?.trim() || DEFAULT_TRANSLATION_MODEL;
}

function truncateForModel(value: string): string {
	if (value.length <= MAX_TRANSLATION_INPUT_CHARS) return value;
	return `${value.slice(0, MAX_TRANSLATION_INPUT_CHARS)}\n\n[Content truncated before translation]`;
}

function extractResponseText(response: OpenAIResponseJson): string {
	if (typeof response.output_text === "string") return response.output_text;
	for (const output of response.output ?? []) {
		for (const content of output.content ?? []) {
			if (
				(content.type === "output_text" || !content.type) &&
				typeof content.text === "string"
			) {
				return content.text;
			}
		}
	}
	return "";
}

function splitTrailingQuotedReplyHtml(html: string): {
	replyHtml: string;
	quotedHtml: string;
} {
	const match = html.match(
		/(\s*(?:<br\s*\/?>)\s*)?(<blockquote\b[\s\S]*<\/blockquote>)\s*$/i,
	);
	if (!match) return { replyHtml: html, quotedHtml: "" };

	return {
		replyHtml: html.slice(0, html.length - match[0].length),
		quotedHtml: match[0],
	};
}

async function callOpenAIJson<T>(
	env: Env,
	options: {
		name: string;
		instructions: string;
		input: unknown;
		schema: Record<string, unknown>;
		maxOutputTokens?: number;
	},
): Promise<T> {
	const res = await fetch(OPENAI_RESPONSES_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getOpenAIKey(env)}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: getTranslationModel(env),
			input: [
				{ role: "system", content: options.instructions },
				{ role: "user", content: JSON.stringify(options.input) },
			],
			max_output_tokens: options.maxOutputTokens ?? 4096,
			store: false,
			text: {
				format: {
					type: "json_schema",
					name: options.name,
					schema: options.schema,
					strict: true,
				},
			},
		}),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`OpenAI translation failed: ${res.status} ${detail}`);
	}

	const payload = (await res.json()) as OpenAIResponseJson;
	const text = extractResponseText(payload).trim();
	if (!text) throw new Error("OpenAI translation returned an empty response");
	return JSON.parse(text) as T;
}

export function isChineseLanguage(
	language?: string | null,
	languageName?: string | null,
): boolean {
	const code = (language || "").toLowerCase();
	const name = (languageName || "").toLowerCase();
	return (
		code === "zh" ||
		code.startsWith("zh-") ||
		name.includes("chinese") ||
		name.includes("中文")
	);
}

export async function translateIncomingEmail(
	env: Env,
	input: { subject?: string | null; body?: string | null },
): Promise<IncomingEmailTranslation> {
	const bodyText = truncateForModel(stripHtmlToText(input.body || ""));
	const subject = truncateForModel(input.subject || "");

	return callOpenAIJson<IncomingEmailTranslation>(env, {
		name: "incoming_email_translation",
		instructions:
			"你是多语言客服邮件翻译助手，请将收到的邮件内容准确得翻译成中文。请识别邮件原文语言，将主题和正文翻译为简体中文，保留姓名、数字、URL、邮箱地址、产品名称和事实含义。若邮件已经是中文，请规范为简体中文。只返回 JSON。",
		input: {
			subject,
			bodyText,
		},
		maxOutputTokens: 8192,
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				sourceLanguage: { type: "string" },
				sourceLanguageName: { type: "string" },
				translatedSubjectZh: { type: "string" },
				translatedBodyZh: { type: "string" },
			},
			required: [
				"sourceLanguage",
				"sourceLanguageName",
				"translatedSubjectZh",
				"translatedBodyZh",
			],
		},
	});
}

export function incomingTranslationToStoredBody(
	translation: IncomingEmailTranslation,
): string {
	return textToHtml(translation.translatedBodyZh);
}

export async function translateReplyForPreview(
	env: Env,
	input: {
		html?: string | null;
		text?: string | null;
		targetLanguage: string;
		targetLanguageName?: string | null;
	},
): Promise<ReplyTranslationPreview> {
	const targetLanguageName = input.targetLanguageName || input.targetLanguage;
	const { replyHtml, quotedHtml } = input.html
		? splitTrailingQuotedReplyHtml(input.html)
		: { replyHtml: "", quotedHtml: "" };
	const originalTextZh = truncateForModel(
		input.html ? stripHtmlToText(replyHtml) : input.text || "",
	);
	const originalHtmlZh = input.html ? input.html : textToHtml(input.text || "");

	if (isChineseLanguage(input.targetLanguage, targetLanguageName)) {
		return {
			translationRequired: false,
			targetLanguage: input.targetLanguage,
			targetLanguageName,
			originalHtmlZh,
			originalTextZh,
			translatedHtml: originalHtmlZh,
			translatedText: originalTextZh,
		};
	}

	const translated = await callOpenAIJson<{ translatedText: string }>(env, {
		name: "outgoing_reply_translation",
		instructions:
			"你是多语言客服邮件翻译助手，请根据我的中文邮件回复内容要点，生成专业的客服邮件回复，并翻译成对应邮件原文中的语言。在生成客户邮件回复时，要尽量符合客服沟通的专业口吻，内容准确、礼貌且条理清晰。\n若用户有额外的具体指令（如需要加入个性化问候、引用订单号等），请在回复邮件中根据上下文进行融入。若你对原始邮件语言的判断存在不确定性，请尽量根据上下文信息推断；若无法确定，可向用户确认。\n请只生成将发送给客户的当前回复正文；邮件历史引用块会由系统原样附回，不需要改写或翻译。请保留姓名、数字、URL、邮箱地址、产品名称和必要上下文，不要添加解释或 markdown。只返回 JSON。",
		input: {
			targetLanguage: input.targetLanguage,
			targetLanguageName,
			emailTextZh: originalTextZh,
		},
		maxOutputTokens: 8192,
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				translatedText: { type: "string" },
			},
			required: ["translatedText"],
		},
	});

	return {
		translationRequired: true,
		targetLanguage: input.targetLanguage,
		targetLanguageName,
		originalHtmlZh,
		originalTextZh,
		translatedHtml: `${textToHtml(translated.translatedText)}${quotedHtml}`,
		translatedText: quotedHtml
			? `${translated.translatedText}\n\n${stripHtmlToText(quotedHtml)}`
			: translated.translatedText,
	};
}
