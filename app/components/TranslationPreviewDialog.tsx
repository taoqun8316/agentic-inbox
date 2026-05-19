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
			<Dialog size="lg" className="max-h-[85vh] overflow-y-auto">
				<Dialog.Title>发送前预览</Dialog.Title>
				{preview && (
					<div className="mt-4 space-y-4">
						<div className="text-sm text-kumo-subtle">
							发出语言：{preview.targetLanguageName}
						</div>
						<div className="grid gap-4 md:grid-cols-2">
							<div className="min-h-[220px] overflow-hidden rounded-md border border-kumo-line">
								<div className="border-b border-kumo-line bg-kumo-tint/50 px-3 py-2 text-xs font-medium text-kumo-subtle">
									中文回复
								</div>
								<EmailIframe body={preview.originalHtmlZh} autoSize />
							</div>
							<div className="min-h-[220px] overflow-hidden rounded-md border border-kumo-line">
								<div className="border-b border-kumo-line bg-kumo-tint/50 px-3 py-2 text-xs font-medium text-kumo-subtle">
									将发送给客户
								</div>
								<EmailIframe body={preview.translatedHtml} autoSize />
							</div>
						</div>
					</div>
				)}
				<div className="mt-5 flex justify-end gap-2">
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
