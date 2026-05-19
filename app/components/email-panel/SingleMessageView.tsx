// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailIframe from "~/components/EmailIframe";
import { formatDetailDate, rewriteInlineImages } from "~/lib/utils";
import type { Email } from "~/types";

interface SingleMessageViewProps {
	email: Email;
	mailboxId?: string;
	onPreviewImage: (url: string, filename: string) => void;
}

export default function SingleMessageView({
	email,
	mailboxId,
	onPreviewImage,
}: SingleMessageViewProps) {
	const [showOriginal, setShowOriginal] = useState(false);
	const hasTranslation = Boolean(email.translated_body_zh);
	const isTranslationPending = email.translation_status === "pending";
	const isTranslationFailed = email.translation_status === "failed";
	const displayBody = !showOriginal && email.translated_body_zh
		? email.translated_body_zh
		: email.body || "";

	useEffect(() => {
		setShowOriginal(false);
	}, [email.id]);

	return (
		<div className="flex flex-col h-full">
			<div className="px-4 py-4 border-b border-kumo-line md:px-6">
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2.5 min-w-0">
						<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-xs font-bold text-kumo-default">
							{email.sender.charAt(0).toUpperCase()}
						</div>
						<div className="min-w-0">
							<div className="text-sm font-medium text-kumo-default truncate">
								{email.sender}
							</div>
							<div className="text-xs text-kumo-subtle">To: {email.recipient}</div>
						</div>
					</div>
					<span className="text-xs text-kumo-subtle shrink-0">
						{formatDetailDate(email.date)}
					</span>
				</div>
			</div>

			{(hasTranslation || isTranslationPending || isTranslationFailed) && (
				<div className="px-4 py-3 border-b border-kumo-line bg-kumo-tint/40 md:px-6">
					<div className="flex items-start justify-between gap-3">
						{isTranslationPending ? (
							<p className="text-sm text-kumo-subtle">
								正在翻译，稍后自动更新。
							</p>
						) : isTranslationFailed ? (
							<p className="text-sm text-kumo-subtle">
								翻译失败，请检查 OPENAI_API_KEY 或 Worker 日志。
							</p>
						) : (
							<p className="text-sm text-kumo-subtle">
								{showOriginal ? "当前显示原文" : "当前显示中文译文"}
							</p>
						)}
						{hasTranslation && (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => setShowOriginal((value) => !value)}
							>
								{showOriginal ? "查看译文" : "查看原文"}
							</Button>
						)}
					</div>
				</div>
			)}

			<div className="flex-1 min-h-0">
				<EmailIframe
					body={rewriteInlineImages(
						displayBody,
						mailboxId || "",
						email.id,
						email.attachments,
					)}
				/>
			</div>

			<EmailAttachmentList
				mailboxId={mailboxId}
				emailId={email.id}
				attachments={email.attachments}
				onPreviewImage={onPreviewImage}
				className="px-4 py-3 border-t border-kumo-line shrink-0 md:px-6"
				showHeading
			/>
		</div>
	);
}
