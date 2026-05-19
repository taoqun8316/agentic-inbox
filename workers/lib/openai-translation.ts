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
	summaryZh: string;
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
			"Identify the source language of the email, translate the subject and body into Simplified Chinese, and write a concise Simplified Chinese summary. Preserve names, numbers, URLs, product names, and factual meaning. If the email is already Chinese, normalize to Simplified Chinese. Return JSON only.",
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
				summaryZh: { type: "string" },
			},
			required: [
				"sourceLanguage",
				"sourceLanguageName",
				"translatedSubjectZh",
				"translatedBodyZh",
				"summaryZh",
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
	const originalTextZh = truncateForModel(
		stripHtmlToText(input.html || "") || input.text || "",
	);
	const originalHtmlZh = input.html || textToHtml(input.text || "");

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
			"Translate the outgoing email from Chinese into the customer's target language. Keep the tone professional and natural. Preserve names, numbers, URLs, email addresses, product names, and quoted context. Do not add explanations or markdown. Return JSON only.",
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
		translatedHtml: textToHtml(translated.translatedText),
		translatedText: translated.translatedText,
	};
}
