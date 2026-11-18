/** Host-owned gathering lifecycle. The iframe only edits settings and displays state. */
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { bgSetInterval } from "./bg-timer";
import { loadCharacters } from "./character-storage";
import { addChatContact, createOrGetSession, loadChatContacts, loadChatSessions } from "./chat-storage";
import { appendCustomAppTimelineEntry, loadCustomAppTimelineEntries, loadInstalledCustomApps } from "./custom-app-storage";
import type { InstalledCustomApp } from "./custom-app-types";
import { generateGatheringTask, parseGatheringJson, validateGatheringOutput } from "./gathering-prompt";
import { planGatheringContact, sendGatheringContact } from "./follow-up-service";
import { requestGatheringMoment } from "./moments-engine";
import { GATHERING_MAX_TRIALS, GATHERING_POLL_MS, gatheringStoryLength, missedGatheringTick, nextGatheringOpportunity, shouldAttemptGatheringContact } from "./gathering-policy";

const KEY = "ai_phone_native_gatherings_v1";
registerKvMigration(KEY);
type Progress = "pending" | "running" | "done" | "skipped" | "error" | "interrupted";
export type Gathering = {
    id: string; appId: string; appName: string; characterId: string; sessionId: string;
    date: string; location: string; activity: string; participants: string[];
    status: "active" | "ended"; createdAt: string; endedAt?: string;
    story: string; summary: string; storyState: Progress; storyError?: string;
    trials: number; contactsSent: number; contactState: Progress; contactError?: string;
    momentState: Progress; momentError?: string; memoryWritten?: boolean;
};
type Live = { nextAt: number; controller: AbortController; busy: boolean; sendAt?: number; context?: string; phase: "active" | "ended"; contactPlanned?: boolean };
const live = new Map<string, Live>();
let stopTimer: (() => void) | undefined;
let releaseLeader: (() => void) | undefined;
let leader = false;
let running = false;
let generation = 0;
let lastTick = 0;

function all(): Gathering[] {
    try { const value: unknown = JSON.parse(kvGet(KEY) || "[]"); return Array.isArray(value) ? value as Gathering[] : []; }
    catch { return []; }
}
function save(rows: Gathering[]): void {
    kvSet(KEY, JSON.stringify(rows));
    window.dispatchEvent(new CustomEvent("gathering-updated"));
}
function update(id: string, patch: Partial<Gathering>): Gathering | undefined {
    const rows = all(); const item = rows.find(e => e.id === id);
    if (!item) return;
    Object.assign(item, patch); save(rows); return item;
}
function get(id: string): Gathering | undefined { return all().find(e => e.id === id); }
function message(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请检查API配置。"; }
function context(e: Gathering): string {
    return JSON.stringify({ eventId: e.id, phase: e.status === "active" ? "聚会正在进行，请勿当作已结束" : "聚会已由User点击结束", plannedDate: e.date,
        note: "日期仅为剧情设定。聚会从用户点击开始时立即运行，不等待日历日期。", location: e.location, activity: e.activity,
        participants: e.participants, story: e.story, summary: e.summary });
}
function isCurrent(e: Gathering, rt: Live): boolean {
    const current = get(e.id);
    return leader && !rt.controller.signal.aborted && live.get(e.id) === rt && current?.status === rt.phase
        && loadInstalledCustomApps().some(a => a.id === e.appId)
        && loadCharacters().some(c => c.id === e.characterId)
        && loadChatSessions().some(s => s.id === e.sessionId && !s.isGroup && s.contactId === e.characterId);
}
function runtime(e: Gathering): Live {
    const rt: Live = { nextAt: nextGatheringOpportunity(Date.now()), controller: new AbortController(), busy: false, phase: e.status };
    live.set(e.id, rt); return rt;
}
function stopEvent(id: string): void { live.get(id)?.controller.abort(); live.delete(id); }

async function generateStory(e: Gathering, rt: Live): Promise<void> {
    rt.busy = true; update(e.id, { storyState: "running", storyError: undefined });
    try {
        let result: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 2; attempt++) {
            result = parseGatheringJson(await generateGatheringTask(e.sessionId,
                `根据资料生成一次完整的第三人称聚会短篇，起承转合完整，不写成聊天记录。正文必须含1200—2000个汉字。当前男主与所选朋友/NPC参加，User不参加。日期是剧情设定，未来日期也已即时启动。\n输入：${JSON.stringify({ date: e.date, location: e.location, activity: e.activity, participants: e.participants })}\n只输出JSON：{"story":"完整正文","summary":"100—600字的客观关键事件摘要，仅包含本次已发生事实"}。${attempt ? "上次篇幅不符合要求，请重新完整生成，不要截断。" : ""}`, rt.controller.signal));
            const n = gatheringStoryLength(String(result.story || ""));
            if (n >= 1200 && n <= 2000) break;
        }
        const story = typeof result.story === "string" ? result.story.trim() : "";
        const summary = typeof result.summary === "string" ? result.summary.trim() : "";
        const n = gatheringStoryLength(story);
        if (n < 1200 || n > 2000 || !summary || summary.length > 800) throw new Error("正文篇幅或摘要格式不符合要求，请重试生成。");
        await validateGatheringOutput(e.sessionId, JSON.stringify({ story, summary, location: e.location, activity: e.activity, participants: e.participants }), rt.controller.signal);
        if (!isCurrent(e, rt)) return;
        update(e.id, { story, summary, storyState: "done" });
        rt.nextAt = nextGatheringOpportunity(Date.now());
    } catch (error) {
        if (isCurrent(e, rt)) update(e.id, { storyState: "error", storyError: message(error) });
    } finally { rt.busy = false; }
}

async function contactOpportunity(e: Gathering, rt: Live): Promise<void> {
    rt.busy = true;
    try {
        if (rt.sendAt === undefined) {
            rt.contactPlanned = true;
            const plan = await planGatheringContact(e.sessionId, context(e), rt.controller.signal);
            if (!isCurrent(e, rt)) return;
            if (!plan.contact) {
                update(e.id, { contactState: e.status === "ended" ? "skipped" : "pending" });
                if (e.status === "ended") rt.nextAt = Infinity;
                return;
            }
            rt.sendAt = Date.now() + plan.delaySeconds * 1000;
            rt.context = context(e);
        }
        if (rt.sendAt > Date.now()) return;
        if (!isCurrent(e, rt)) return;
        update(e.id, { contactState: "running" });
        const outcome = await sendGatheringContact(e.sessionId, rt.context || context(e), rt.controller.signal, () => isCurrent(e, rt), e.id);
        if (!isCurrent(e, rt)) return;
        if (outcome === "busy") { rt.sendAt = Date.now() + 15_000; return; }
        if (outcome === "sent") update(e.id, { contactsSent: (get(e.id)?.contactsSent || 0) + 1, contactState: "done" });
        else update(e.id, { contactState: "skipped" });
        rt.sendAt = undefined;
        if (e.status === "ended") rt.nextAt = Infinity;
    } catch (error) {
        if (isCurrent(e, rt)) update(e.id, { contactState: "error", contactError: message(error) });
        rt.sendAt = undefined; if (e.status === "ended") rt.nextAt = Infinity;
    } finally { rt.busy = false; }
}

async function settle(e: Gathering, rt: Live): Promise<void> {
    // End is a synchronous state transition BEFORE any network calls.
    // Each native channel receives facts only; they independently decide what to say/publish.
    try {
        update(e.id, { momentState: "running" });
        const result = await requestGatheringMoment(e.characterId, {
            eventId: e.id, context: context(e), signal: rt.controller.signal,
            validate: text => validateGatheringOutput(e.sessionId, text, rt.controller.signal),
        });
        if (!isCurrent(e, rt)) return;
        if (result === "busy") { update(e.id, { momentState: "pending" }); }
        else update(e.id, { momentState: "done" });
    } catch (error) {
        if (isCurrent(e, rt)) update(e.id, { momentState: "error", momentError: message(error) });
    }
    if (isCurrent(e, rt) && !rt.contactPlanned) await contactOpportunity(get(e.id) || e, rt);
}

async function tick(): Promise<void> {
    if (!leader) return;
    const now = Date.now(); const missed = missedGatheringTick(lastTick, now); lastTick = now;
    for (const [id, rt] of live) {
        const e = get(id);
        if (!e || !isCurrent(e, rt)) { stopEvent(id); continue; }
        if (missed) {
            // No catch-up burst after OS freeze/suspension. Discard overdue contact plans.
            rt.nextAt = e.status === "active" ? nextGatheringOpportunity(now) : Infinity;
            rt.sendAt = undefined; rt.context = undefined;
            if (e.status === "ended" && e.contactState === "pending") update(id, { contactState: "skipped" });
            continue;
        }
        if (rt.busy || e.storyState !== "done") continue;
        if (rt.sendAt !== undefined) {
            if (rt.sendAt <= now) void contactOpportunity(e, rt);
            continue;
        }
        if (e.status === "ended") {
            if (e.momentState === "pending") {
                rt.busy = true;
                void settle(e, rt).finally(() => { rt.busy = false; });
            }
            continue;
        }
        if (now < rt.nextAt || e.trials >= GATHERING_MAX_TRIALS) continue;
        rt.nextAt = nextGatheringOpportunity(now);
        update(id, { trials: e.trials + 1 });
        if (shouldAttemptGatheringContact(e.trials)) void contactOpportunity(e, rt);
    }
}

function boot(): void {
    leader = true; lastTick = Date.now();
    const rows = all();
    for (const e of rows) {
        if (e.status === "active") {
            runtime(e);
            if (e.storyState === "running") { e.storyState = "error"; e.storyError = "网页关闭中断了生成，可手动重试。"; }
        } else {
            if (["pending", "running"].includes(e.contactState)) e.contactState = "interrupted";
            if (["pending", "running"].includes(e.momentState)) e.momentState = "interrupted";
        }
    }
    save(rows);
    stopTimer = bgSetInterval(() => { void tick(); }, GATHERING_POLL_MS);
    window.addEventListener("pagehide", onPageHide);
}
function onPageHide(): void {
    stopGatheringService();
    window.addEventListener("pageshow", startGatheringService, { once: true });
}
export function startGatheringService(): void {
    if (running) return; running = true;
    const epoch = ++generation;
    if (navigator.locks) {
        void navigator.locks.request("float-native-gathering-v1", { ifAvailable: true }, async lock => {
            if (!lock || !running || epoch !== generation) return;
            boot(); await new Promise<void>(resolve => { releaseLeader = resolve; });
        });
    } else boot(); // Older browsers: one Float tab should be used.
}
export function stopGatheringService(): void {
    running = false; leader = false; generation++;
    stopTimer?.(); stopTimer = undefined;
    for (const id of live.keys()) stopEvent(id);
    releaseLeader?.(); releaseLeader = undefined;
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", startGatheringService);
}

function field(value: unknown, limit: number): string { return String(value ?? "").trim().slice(0, limit); }
export async function handleGatheringRequest(app: InstalledCustomApp, action: string, input: Record<string, unknown>): Promise<unknown> {
    if (!app.permissions.includes("gathering.manage")) throw new Error("兄弟局缺少 gathering.manage 权限，请更新安装包。");
    const characterId = field(input.characterId, 160);
    if (!loadCharacters().some(c => c.id === characterId)) throw new Error("请选择有效男主。");
    if (action === "gathering.status") return { version: "1.0.0", leader,
        events: all().filter(e => e.appId === app.id && e.characterId === characterId) };
    if (!leader) throw new Error("宿主服务尚未就绪，或另一个Float标签页正在运行。请在原标签页操作；关闭它后刷新当前页面。");
    if (!loadChatContacts().some(c => c.characterId === characterId)) addChatContact(characterId);
    const session = createOrGetSession(characterId);
    if (action === "gathering.recommend") {
        const result = parseGatheringJson(await generateGatheringTask(session.id,
            '根据当前男主人设、预设、绑定世界书和当前线记忆推荐3个不同聚会。参加者必须是当前世界书已出现的朋友/NPC，不要读其他男主的人物卡；NPC无需独立卡。User不参加。只输出 {"suggestions":[{"activity":"活动","location":"地点","participants":["NPC名字"],"reason":"简短推荐原因"}]}。'));
        await validateGatheringOutput(session.id, JSON.stringify(result));
        if (!Array.isArray(result.suggestions)) throw new Error("推荐格式无效，请重试。");
        return result;
    }
    if (action === "gathering.start") {
        const existing = all().find(e => e.appId === app.id && e.characterId === characterId && e.status === "active");
        if (existing) return existing;
        const date = field(input.date, 10), location = field(input.location, 180), activity = field(input.activity, 300);
        const participants = Array.isArray(input.participants) ? [...new Set(input.participants.map(n => field(n, 100)).filter(Boolean))].slice(0, 12) : [];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || !location || !activity || !participants.length) throw new Error("请填写有效日期、地点、活动和至少一位朋友/NPC。");
        const e: Gathering = { id: crypto.randomUUID(), appId: app.id, appName: app.name, characterId, sessionId: session.id,
            date, location, activity, participants, status: "active", createdAt: new Date().toISOString(), story: "", summary: "", storyState: "pending",
            trials: 0, contactsSent: 0, contactState: "pending", momentState: "pending" };
        save([e, ...all()]);
        const rt = runtime(e); void generateStory(e, rt); return get(e.id);
    }
    const e = get(field(input.eventId, 160));
    if (!e || e.appId !== app.id || e.characterId !== characterId) throw new Error("聚会不存在或不属于当前男主线。");
    if (action === "gathering.retryStory") {
        if (e.status !== "active" || e.storyState !== "error") throw new Error("只有生成失败的进行中聚会可以重试。");
        const rt = live.get(e.id) || runtime(e); if (!rt.busy) void generateStory(e, rt); return get(e.id);
    }
    if (action === "gathering.end") {
        if (e.status === "ended") return e; // Idempotent: never repeat memory/social effects.
        stopEvent(e.id);
        const ended = update(e.id, { status: "ended", endedAt: new Date().toISOString(),
            storyState: e.story ? "done" : "interrupted", contactState: e.story ? "pending" : "skipped", momentState: e.story ? "pending" : "skipped" })!;
        if (!ended.story || !ended.summary) return ended;
        const written = loadCustomAppTimelineEntries(characterId).some(t => t.appId === app.id && t.data?.appEventId === e.id);
        if (!written) appendCustomAppTimelineEntry(app, { characterId, appLabel: "兄弟局", appEventId: e.id,
            summary: `兄弟局已结束（剧情日期${e.date}；地点${e.location}）：${e.summary}`,
            data: { appEventId: e.id, shortTermOnly: true } });
        update(e.id, { memoryWritten: true });
        const rt = runtime(ended); rt.busy = true; rt.nextAt = Infinity;
        void settle(ended, rt).finally(() => { rt.busy = false; });
        return get(e.id);
    }
    throw new Error("未知兄弟局操作。");
}
