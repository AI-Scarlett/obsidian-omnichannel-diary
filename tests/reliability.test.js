"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DiaryService } = require("../src/core/diary");
const { WeChatChannel } = require("../src/channels/wechat");

function settings() {
  return {
    storage: { diaryFolder: "日记", clippingFolder: "剪藏", attachmentFolder: "附件", addSourceMetadata: true },
    capture: { autoClipLinks: false, downloadWebImages: false, downloadChatAttachments: false, maxFileMb: 20, includeGroupMessages: true, requireMentionInGroups: false },
    runtime: { recentMessageIds: [], pendingReceipts: [] },
  };
}

test("a message is remembered only after its diary entry is written", async () => {
  const value = settings();
  let shouldFail = true;
  const writer = {
    append: async () => {
      if (shouldFail) throw new Error("disk full");
      return { path: "日记/today.md" };
    },
  };
  const diary = new DiaryService(writer, () => value, async () => {});
  const envelope = { channel: "wechat", id: "message-1", timestamp: new Date("2026-08-30T02:00:00Z"), text: "hello", attachments: [] };
  await assert.rejects(() => diary.capture(envelope), /disk full/);
  assert.deepEqual(value.runtime.recentMessageIds, []);

  shouldFail = false;
  const saved = await diary.capture(envelope);
  assert.equal(saved.messageKey, "wechat:message-1");
  assert.deepEqual(value.runtime.recentMessageIds, ["wechat:message-1"]);
  const duplicate = await diary.capture(envelope);
  assert.equal(duplicate.ignored, "duplicate");
});

test("WeChat advances its sync cursor only after every message succeeds", async () => {
  let saves = 0;
  const config = { token: "token", syncBuf: "old" };
  const channel = new WeChatChannel(config, { setStatus() {}, saveSettings: async () => { saves += 1; } });
  const update = { get_updates_buf: "new", msgs: [{ message_type: 1, message_id: "one", from_user_id: "user", create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text: "hello" } }] }] };
  channel.deliver = async () => ({ ok: false, error: new Error("reply failed") });
  await assert.rejects(() => channel.processUpdate(update), /reply failed/);
  assert.equal(config.syncBuf, "old");
  assert.equal(saves, 0);

  channel.deliver = async () => ({ ok: true });
  await channel.processUpdate(update);
  assert.equal(config.syncBuf, "new");
  assert.equal(saves, 1);
});
