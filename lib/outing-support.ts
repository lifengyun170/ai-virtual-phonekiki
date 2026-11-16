"use client";

import type { InstalledCustomApp } from './custom-app-types';
import {
  ensureSettingsStorageHydrated,
  loadBindingConfig,
  resolveBinding,
  loadPresets,
  loadWorldBooks,
} from './settings-storage';
import { loadCharacters } from './character-storage';
import {
  hydrateChatStorage,
  createOrGetSession,
  type ChatMessage,
} from './chat-storage';
import { generateOfflineChatCompletion } from './chat-engine';
import {
  readCustomAppCollection,
  writeCustomAppCollection,
} from './custom-app-storage';
import { hydrateKvDb } from './kv-db';
import {
  loadMemoryEntries,
  saveMemoryEntry,
} from './memory-storage';
import {
  hydrateMomentsStorage,
  addMomentPost,
  loadMomentPosts,
} from './moments-storage';
import { momentsDb } from './moments-db';

const text = (x: unknown, n = 12000) =>
  typeof x === 'string' ? x.trim().slice(0, n) : '';

export async function handleOutingAction(
  app: InstalledCustomApp,
  action: string,
  payload: Record<string, unknown>,
) {
  const need = (p: string) => {
    if (!(app.permissions as string[]).includes(p)) {
      throw new Error(`缺少权限：${p}`);
    }
  };

  need('app.data.read');
  need('characters.read');

  await hydrateKvDb();
  await ensureSettingsStorageHydrated();
  await hydrateChatStorage();

  const characterId = text(payload.characterId, 160);
  const characters = loadCharacters();

  if (!characters.some(c => c.id === characterId)) {
    throw new Error('角色不存在');
  }

  if (action === 'outing.context') {
    const slot = resolveBinding(
      loadBindingConfig(),
      characterId,
      'chat',
    );

    const preset =
      loadPresets().find(p => p.id === slot.presetId) ??
      loadPresets().find(p => p.builtIn);

    return {
      version: 1,
      presetName: preset?.name ?? '未绑定预设',
      presetId: preset?.id,
      tags: ['chat', 'offline'],
      worldBooks: loadWorldBooks()
        .filter(w => slot.worldBookIds?.includes(w.id))
        .map(w => ({
          id: w.id,
          name: w.name,
        })),
      otherCharacters: characters
        .filter(c => c.id !== characterId)
        .map(c => ({
          id: c.id,
          name: c.name,
        })),
    };
  }

  if (action === 'outing.generate') {
    need('ai.generate');

    const base = createOrGetSession(characterId);

    // 使用和私聊线下完全相同的绑定与生成入口。
    // 历史只传入内存，不保存为聊天轮次。
    const session = {
      ...base,
      offlineSummaryRetry: false,
    };

    const input = Array.isArray(payload.messages)
      ? payload.messages
      : [];

    const history: ChatMessage[] = input
      .slice(-100)
      .map((v, i) => {
        const r = v as Record<string, unknown>;

        return {
          id: `outing_${i}`,
          sessionId: base.id,
          role: r.role === 'assistant' ? 'assistant' : 'user',
          content: text(r.content, 24000),
          createdAt:
            text(r.createdAt, 80) ||
            new Date().toISOString(),
          status: 'sent',
        };
      });

    history.push({
      id: `outing_task_${Date.now()}`,
      sessionId: base.id,
      role: 'user',
      content: text(payload.instruction, 40000),
      createdAt: new Date().toISOString(),
      status: 'sent',
    });

    const result = await generateOfflineChatCompletion(
      session,
      history,
    );

    return {
      text: result.content,
      presetName: result.presetName,
    };
  }

  if (action === 'outing.complete') {
    need('app.data.write');
    need('memory.write');

    const id = text(payload.eventId, 160);

    const events = readCustomAppCollection(
      app.id,
      'appointments',
    );

    const event = events.find(
      e => e.id === id && e.characterId === characterId,
    );

    if (
      !event ||
      !['finishing', 'complete'].includes(String(event.status))
    ) {
      throw new Error('只能保存完整结束的活动');
    }

    const turns = Array.isArray(event.turns)
      ? event.turns
      : [];

    const last = turns[turns.length - 1] as
      | Record<string, unknown>
      | undefined;

    const scene = last?.scene as
      | Record<string, unknown>
      | undefined;

    if (
      !scene?.canEnd ||
      !text(event.finalSummary, 2800)
    ) {
      throw new Error('活动尚未完整结束');
    }

    const stamp = new Date().toISOString();

    // 稳定记忆 ID：断线重试覆盖同一条，不重复追加。
    const memoryId = `outing_${app.id}_${id}`;

    await saveMemoryEntry({
      id: memoryId,
      characterId,
      sourceApp: 'chat',
      type: 'long_term',
      content: text(event.finalSummary, 2800),
      importance: 0.65,
      createdAt: text(event.finishedAt, 80) || stamp,
      updatedAt: stamp,
      metadata: {
        origin: 'custom_app',
        appId: app.id,
        appName: app.name,
        reason: '完整完成线下活动',
      },
    });

    const savedMemories =
      await loadMemoryEntries(characterId);

    if (!savedMemories.some(m => m.id === memoryId)) {
      throw new Error(
        '记忆写入未确认，请检查浏览器存储后重试',
      );
    }

    let momentId = text(event.momentId, 180);

    const moment = event.finalMoment as
      | Record<string, unknown>
      | undefined;

    if (
      event.allowMoment === true &&
      moment?.publish === true &&
      text(moment.content, 2000)
    ) {
      await hydrateMomentsStorage();

      const content = text(moment.content, 2000);

      const existing = momentId
        ? loadMomentPosts().find(p => p.id === momentId)
        : loadMomentPosts().find(
            p =>
              p.authorType === 'character' &&
              p.authorId === characterId &&
              p.content === content,
          );

      const post =
        existing ??
        addMomentPost({
          authorType: 'character',
          authorId: characterId,
          content,
          visibility: [characterId],
          location: text(event.location, 160),
        });

      if (!post) {
        throw new Error(
          '朋友圈写入未确认，可重试完成',
        );
      }

      await momentsDb.posts.put(post);
      momentId = post.id;

      window.dispatchEvent(
        new CustomEvent('moments-updated'),
      );
    }

    const patch = {
      ...event,
      status: 'complete',
      finishedAt: event.finishedAt || stamp,
      memoryId,
      momentId,
    };

    writeCustomAppCollection(
      app.id,
      'appointments',
      events.map(e => (e.id === id ? patch : e)),
    );

    return patch;
  }

  throw new Error('未知赴约接口');
}
