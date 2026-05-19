// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog } from "@cloudflare/kumo";
import EmailIframe from "~/components/EmailIframe";
import type { ReplyTranslationPreview } from "~/types";

interface TranslationPreviewDialogProps {
	preview: ReplyTranslationPreview | null;
	isSending?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}

function PreviewPane({ title, body }: { title: string; body: string }) {
	return (
		<div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-kumo-line bg-kumo-base">
			<div className="shrink-0 border-b border-kumo-line bg-kumo-tint/50 px-3 py-2 text-xs font-medium text-kumo-subtle">
				{title}
			</div>
			<div className="min-h-0 flex-1">
				<EmailIframe body={body} />
			</div>
		</div>
	);
}

export default function TranslationPreviewDialog({
	preview,
	isSending,
	onCancel,
	onConfirm,
}: TranslationPreviewDialogProps) {
	return (
		<Dialog.Root
			open={preview !== null}
			onOpenChange={(open) => {
				if (!open && !isSending) onCancel();
			}}
		>
			<Dialog
				size="xl"
				className="flex h-[min(85vh,760px)] max-h-[calc(100vh-2rem)] flex-col overflow-hidden p-0"
			>
				<div className="shrink-0 border-b border-kumo-line px-5 pb-3 pt-5">
					<Dialog.Title>发送前预览</Dialog.Title>
					{preview && (
						<div className="mt-3 text-sm text-kumo-subtle">
							发出语言：{preview.targetLanguageName}
						</div>
					)}
				</div>
				{preview && (
					<div className="min-h-0 flex-1 p-5">
						<div className="grid h-full min-h-0 grid-rows-2 gap-4 md:grid-cols-2 md:grid-rows-1">
							<PreviewPane title="原始回复内容" body={preview.originalHtmlZh} />
							<PreviewPane title="将发送给客户" body={preview.translatedHtml} />
						</div>
					</div>
				)}
				<div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line px-5 py-3">
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onClick={onCancel}
						disabled={isSending}
					>
						取消
					</Button>
					<Button
						type="button"
						variant="primary"
						size="sm"
						onClick={onConfirm}
						loading={isSending}
						disabled={isSending}
					>
						{isSending ? "发送中..." : "确认发送"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
