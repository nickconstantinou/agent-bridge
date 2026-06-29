import type { MessagingPlatform } from "../../src/platform.js";

declare const platform: MessagingPlatform;

type IsAny<T> = 0 extends (1 & T) ? true : false;
type Expect<T extends true> = T;
type IsNotAny<T> = IsAny<T> extends true ? false : true;

type SendMessageBody = Parameters<MessagingPlatform["sendMessage"]>[0];
type SendMessageResult = Awaited<ReturnType<MessagingPlatform["sendMessage"]>>;
type GetUpdatesOptions = Parameters<MessagingPlatform["getUpdates"]>[0];
type GetUpdatesResult = Awaited<ReturnType<MessagingPlatform["getUpdates"]>>;
type EditMessageTextBody = Parameters<MessagingPlatform["editMessageText"]>[0];
type CallbackAnswerBody = Parameters<MessagingPlatform["answerCallbackQuery"]>[0];
type CommandsBody = Parameters<MessagingPlatform["setMyCommands"]>[0];

type _sendMessageBodyIsTyped = Expect<IsNotAny<SendMessageBody>>;
type _sendMessageResultIsTyped = Expect<IsNotAny<SendMessageResult>>;
type _getUpdatesOptionsAreTyped = Expect<IsNotAny<GetUpdatesOptions>>;
type _getUpdatesResultIsTyped = Expect<IsNotAny<GetUpdatesResult>>;
type _editMessageTextBodyIsTyped = Expect<IsNotAny<EditMessageTextBody>>;
type _callbackAnswerBodyIsTyped = Expect<IsNotAny<CallbackAnswerBody>>;
type _commandsBodyIsTyped = Expect<IsNotAny<CommandsBody>>;

async function validPlatformCalls() {
  await platform.getUpdates({ offset: 1, timeout: 30, allowed_updates: ["message", "callback_query"] });
  await platform.sendMessage({ chat_id: 123, text: "hello" });
  await platform.sendMessage({ chat_id: "discord-channel", text: "hello" });
  await platform.sendRichMessage?.({ chat_id: 123, rich_message: { html: "<b>hello</b>" } });
  await platform.editMessageText({ chat_id: 123, message_id: 456, text: "edited" });
  await platform.sendChatAction({ chat_id: 123, action: "typing" });
  await platform.answerCallbackQuery({ callback_query_id: "callback-1", text: "ok" });
  await platform.setMyCommands({ commands: [{ command: "help", description: "Show help" }] });
  await platform.sendDocumentBuffer?.({
    chat_id: 123,
    bytes: Buffer.from("hello"),
    filename: "response.md",
    mime_type: "text/markdown",
    caption: "Full response attached",
  });
}

// @ts-expect-error sendMessage requires message content.
platform.sendMessage({ chat_id: 123 });

// @ts-expect-error sendMessage text must be a string.
platform.sendMessage({ chat_id: 123, text: 42 });

// @ts-expect-error getUpdates offset must be numeric.
platform.getUpdates({ offset: "1", timeout: 30 });

// @ts-expect-error editMessageText requires a message identifier.
platform.editMessageText({ chat_id: 123, text: "edited" });

// @ts-expect-error answerCallbackQuery text must be a string.
platform.answerCallbackQuery({ callback_query_id: "callback-1", text: 123 });

// @ts-expect-error command descriptions are required.
platform.setMyCommands({ commands: [{ command: "help" }] });

// @ts-expect-error document bytes must be a Buffer.
platform.sendDocumentBuffer?.({ chat_id: 123, bytes: "hello", filename: "response.md" });

void validPlatformCalls;
