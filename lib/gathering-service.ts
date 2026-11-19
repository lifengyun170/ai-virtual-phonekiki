import { bindGatheringParticipants, projectGatheringParticipantMemory, type ParticipantMemory } from "./gathering-participant-memory";
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
    participantMemories?: ParticipantMemory[];
    participantSocialsEnabled?: boolean;
    socialDispatchClosed?: boolean;
    parentEventId?: string;
    initiatorName?: string;
    status: "active" | "ended"; createdAt: string; endedAt?: string;
    story: string; summary: string; storyState: Progress; storyError?: string;
    trials: number; contactsSent: number; contactState: Progress; contactError?: string;
    momentState: Progress; momentError?: string; memoryWritten?: boolean;
};
type Live = { nextAt: number; controller: AbortController; busy: boolean; sendAt?: number; context?: string; phase: "active" | "ended"; contactPlanned?: boolean };
const live = new Map<string, Live>();
const memoryJobs = new Map<string, AbortController>();
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
function participantView(parent: Gathering, p: ParticipantMemory): Gathering | undefined {
    if (!p.social || !p.sharedContext) return;
    return { ...parent, ...p.social, parentEventId: parent.id,
        characterId: p.characterId, sessionId: p.social.sessionId,
        participants: [...new Set([parent.initiatorName || "聚会发起人", ...parent.participants])],
        story: p.sharedContext, summary: p.sharedContext, storyState: "done", participantMemories: undefined };
}
function update(id: string, patch: Partial<Gathering>): Gathering | undefined {
    const rows = all(); const item = rows.find(e => e.id === id);
    if (item) { Object.assign(item, patch); save(rows); return item; }
    for (const parent of rows) {
        const participant = parent.participantMemories?.find(p => p.social?.id === id);
        if (!participant?.social) continue;
        Object.assign(participant.social, patch); save(rows); return participantView(parent, participant);
    }
}
function get(id: string): Gathering | undefined {
    for (const e of all()) {
        if (e.id === id) return e;
        const p = e.participantMemories?.find(p => p.social?.id === id);
        if (p) return participantView(e, p);
    }
}
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
function stopEvent(id: string): void {
    for (const [key, rt] of live) {
        if (key === id || get(key)?.parentEventId === id) { rt.controller.abort(); live.delete(key); }
    }
}

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
        void prepareParticipantSocials(get(e.id)!, rt);
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

function setParticipantMemory(id: string, characterId: string, patch: Partial<ParticipantMemory>): void {
    const e = get(id); if (!e) return;
    update(id, { participantMemories: e.participantMemories?.map(p => p.characterId === characterId ? { ...p, ...patch } : p) });
}

function startParticipantSocial(parentId: string, characterId: string): void {
    const parent = get(parentId);
    const p = parent?.participantMemories?.find(p => p.characterId === characterId);
    if (!parent?.participantSocialsEnabled || parent.socialDispatchClosed || !p?.sharedContext || p.contextState !== "done" || !leader) return;
    // Each phase is handed off once. Memory retries never replay social decisions.
    if (p.social?.phase === parent.status) return;
    if (!loadCharacters().some(c => c.id === characterId)) return;
    if (!loadChatContacts().some(c => c.characterId === characterId)) addChatContact(characterId);
    const session = createOrGetSession(characterId);
    const social = { id: `${parent.id}:participant:${characterId}`, sessionId: session.id,
        phase: parent.status, trials: p.social?.trials || 0, contactsSent: p.social?.contactsSent || 0,
        contactState: "pending" as const, momentState: "pending" as const };
    setParticipantMemory(parent.id, characterId, { social });
    const actor = get(social.id)!;
    const rt = runtime(actor);
    if (parent.status === "ended") {
        rt.busy = true; rt.nextAt = Infinity;
        void settle(actor, rt).finally(() => { rt.busy = false; });
    }
}

async function prepareParticipantSocials(e: Gathering, ownerRuntime: Live): Promise<void> {
    if (!e.participantSocialsEnabled || e.status !== "active" || !e.story) return;
    for (const p of e.participantMemories || []) {
        if (!isCurrent(e, ownerRuntime)) return;
        if (p.contextState === "skipped") continue;
        if (p.sharedContext) { startParticipantSocial(e.id, p.characterId); continue; }
        setParticipantMemory(e.id, p.characterId, { contextState: "running", contextError: undefined });
        try {
            const summary = await projectGatheringParticipantMemory(e.sessionId, e.story, p.name, ownerRuntime.controller.signal);
            if (!isCurrent(e, ownerRuntime)) return;
            if (summary === null) {
                setParticipantMemory(e.id, p.characterId, { contextState: "skipped", state: "skipped", error: "故事未证明本人实际到场。" });
                continue;
            }
            setParticipantMemory(e.id, p.characterId, { sharedContext: summary, contextState: "done" });
            startParticipantSocial(e.id, p.characterId);
        } catch (error) {
            if (isCurrent(e, ownerRuntime)) setParticipantMemory(e.id, p.characterId, { contextState: "error", contextError: message(error) });
        }
    }
}

async function writeParticipantMemories(e: Gathering): Promise<void> {
    if (memoryJobs.has(e.id) || !e.story || e.status !== "ended") return;
    const controller = new AbortController(); memoryJobs.set(e.id, controller);
    try {
        for (const participant of e.participantMemories || []) {
            if (controller.signal.aborted || !leader) break;
            const current = get(e.id)?.participantMemories?.find(p => p.characterId === participant.characterId);
            if (!current || current.state === "skipped") continue;
            if (current.state === "done") { startParticipantSocial(e.id, participant.characterId); continue; }
            const already = () => loadCustomAppTimelineEntries(participant.characterId).some(t => t.appId === e.appId && t.data?.appEventId === e.id);
            if (already()) { setParticipantMemory(e.id, participant.characterId, { state: "done", error: undefined }); startParticipantSocial(e.id, participant.characterId); continue; }
            setParticipantMemory(e.id, participant.characterId, { state: "running", error: undefined });
            try {
                if (!loadCharacters().some(c => c.id === participant.characterId)) throw new Error("该同行角色卡已删除，未写入。");
                const summary = current.sharedContext || await projectGatheringParticipantMemory(e.sessionId, e.story, participant.name, controller.signal);
                if (controller.signal.aborted || !leader) break;
                if (!loadInstalledCustomApps().some(a => a.id === e.appId) || !loadCharacters().some(c => c.id === participant.characterId)) throw new Error("应用或同行角色已删除，未写入。");
                if (summary === null) { setParticipantMemory(e.id, participant.characterId, { contextState: "skipped", state: "skipped", error: "故事未证明本人实际到场。" }); continue; }
                if (!already()) appendCustomAppTimelineEntry({ id: e.appId, name: e.appName }, {
                    characterId: participant.characterId, appLabel: "兄弟局·同行经历", appEventId: e.id,
                    summary: `兄弟局同行经历：${summary}`, createdAt: e.endedAt,
                    data: { appEventId: e.id, shortTermOnly: true, observerCharacterId: participant.characterId },
                });
                setParticipantMemory(e.id, participant.characterId, { sharedContext: summary, contextState: "done", state: "done", error: undefined });
                startParticipantSocial(e.id, participant.characterId);
            } catch (error) {
                if (!controller.signal.aborted) setParticipantMemory(e.id, participant.characterId, { state: "error", error: message(error) });
            }
        }
    } finally {
        if (memoryJobs.get(e.id) === controller) memoryJobs.delete(e.id);
    }
}

async function settle(e: Gathering, rt: Live): Promise<void> {
    // End is a synchronous state transition BEFORE any network calls.
    // Each native channel receives facts only; they independently decide what to say/publish.
    const currentMomentState = get(e.id)?.momentState ?? e.momentState;
    if (currentMomentState !== "done" && currentMomentState !== "skipped") {
        try {
            update(e.id, { momentState: "running", momentError: undefined });
            const result = await requestGatheringMoment(e.characterId, {
                eventId: e.id, context: context(e), signal: rt.controller.signal,
                validate: text => validateGatheringOutput(e.sessionId, text, rt.controller.signal, "moments"),
            });
            if (!isCurrent(e, rt)) return;
            if (result === "busy") { update(e.id, { momentState: "pending" }); }
            else update(e.id, { momentState: "done", momentError: undefined });
        } catch (error) {
            if (isCurrent(e, rt)) update(e.id, { momentState: "error", momentError: message(error) });
        }
    }
    const latest = get(e.id) || e;
    if (isCurrent(e, rt) && !rt.contactPlanned && latest.contactState !== "done" && latest.contactState !== "skipped") {
        update(e.id, { contactError: undefined });
        await contactOpportunity(latest, rt);
    }
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
            for (const p of e.participantMemories || []) {
                if (p.social?.phase === "active" && p.sharedContext) { const actor = get(p.social.id); if (actor) runtime(actor); }
                if (p.contextState === "running") p.contextState = "error";
            }
            if (e.storyState === "running") { e.storyState = "error"; e.storyError = "网页关闭中断了生成，可手动重试。"; }
        } else {
            e.socialDispatchClosed = true;
            e.participantMemories = e.participantMemories?.map(p => ({ ...p,
                state: ["pending", "running"].includes(p.state) ? "interrupted" : p.state,
                social: p.social ? { ...p.social,
                    contactState: ["pending", "running"].includes(p.social.contactState) ? "interrupted" : p.social.contactState,
                    momentState: ["pending", "running"].includes(p.social.momentState) ? "interrupted" : p.social.momentState,
                } : undefined,
            }));
            if (["pending", "running"].includes(e.contactState)) e.contactState = "interrupted";
            if (["pending", "running"].includes(e.momentState)) e.momentState = "interrupted";
        }
    }
    save(rows);
    for (const e of rows) { const rt = live.get(e.id); if (rt && e.storyState === "done") void prepareParticipantSocials(e, rt); }
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
    for (const controller of memoryJobs.values()) controller.abort();
    memoryJobs.clear();
    releaseLeader?.(); releaseLeader = undefined;
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", startGatheringService);
}

function field(value: unknown, limit: number): string { return String(value ?? "").trim().slice(0, limit); }
export async function handleGatheringRequest(app: InstalledCustomApp, action: string, input: Record<string, unknown>): Promise<unknown> {
    if (!app.permissions.includes("gathering.manage")) throw new Error("兄弟局缺少 gathering.manage 权限，请更新安装包。");
    const characterId = field(input.characterId, 160);
    if (!loadCharacters().some(c => c.id === characterId)) throw new Error("请选择有效男主。");
    if (action === "gathering.status") return { version: "1.2.0", leader,
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
        const participantMemories = bindGatheringParticipants(input.participantCharacterIds, characterId, loadCharacters());
        const npcNames = Array.isArray(input.participants) ? [...new Set(input.participants.map(n => field(n, 100)).filter(Boolean))].slice(0, 12) : [];
        const participants = [...new Set([...npcNames, ...participantMemories.map(p => p.name)])];
        if (participants.length > 12) throw new Error("同行总人数最多12位。");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || !location || !activity || !participants.length) throw new Error("请填写有效日期、地点、活动和至少一位朋友/NPC。");
        const e: Gathering = { id: crypto.randomUUID(), appId: app.id, appName: app.name, characterId, sessionId: session.id,
            date, location, activity, participants, participantMemories, participantSocialsEnabled: true, initiatorName: loadCharacters().find(c => c.id === characterId)?.name, status: "active", createdAt: new Date().toISOString(), story: "", summary: "", storyState: "pending",
            trials: 0, contactsSent: 0, contactState: "pending", momentState: "pending" };
        save([e, ...all()]);
        const rt = runtime(e); void generateStory(e, rt); return get(e.id);
    }
    const e = get(field(input.eventId, 160));
    if (!e || e.parentEventId || e.appId !== app.id || e.characterId !== characterId) throw new Error("聚会不存在或不属于当前男主线。");
    if (action === "gathering.retryMemories") {
        if (e.status !== "ended" || !e.story) throw new Error("只能重试已结束聚会的同行记忆。");
        void writeParticipantMemories(e); return get(e.id);
    }
    if (action === "gathering.retryStory") {
        if (e.status !== "active" || e.storyState !== "error") throw new Error("只有生成失败的进行中聚会可以重试。");
        const rt = live.get(e.id) || runtime(e); if (!rt.busy) void generateStory(e, rt); return get(e.id);
    }
    if (action === "gathering.retrySocial") {
        if (!e.story || !e.summary) throw new Error("请等待完整故事生成后再重试社交联动。");
        if (e.status === "active") {
            const hostRt = live.get(e.id) || runtime(e);
            if (["error", "interrupted"].includes(e.contactState) && !hostRt.busy) {
                const patched = update(e.id, { contactState: "pending", contactError: undefined })!;
                hostRt.sendAt = undefined;
                void contactOpportunity(patched, hostRt);
            }
            if ((e.participantMemories || []).some(p => p.contextState === "error")) {
                void prepareParticipantSocials(get(e.id)!, hostRt);
            }
            for (const p of (get(e.id)?.participantMemories || [])) {
                if (!p.social || !["error", "interrupted"].includes(p.social.contactState)) continue;
                const actor = get(p.social.id);
                if (!actor) continue;
                const prt = live.get(p.social.id) || runtime(actor);
                if (prt.busy) continue;
                const updatedActor = update(p.social.id, { contactState: "pending", contactError: undefined });
                if (updatedActor) {
                    prt.sendAt = undefined;
                    void contactOpportunity(updatedActor, prt);
                }
            }
            return get(e.id);
        }
        const retryContact = ["error", "interrupted"].includes(e.contactState);
        const retryMoment = ["error", "interrupted"].includes(e.momentState);
        if (retryContact || retryMoment) {
            const hostLive = live.get(e.id); if (hostLive) { hostLive.controller.abort(); live.delete(e.id); }
            const patched = update(e.id, {
                ...(retryContact ? { contactState: "pending", contactError: undefined } : {}),
                ...(retryMoment ? { momentState: "pending", momentError: undefined } : {}),
            })!;
            const rt = runtime(patched);
            rt.busy = true;
            rt.nextAt = Infinity;
            rt.contactPlanned = !retryContact;
            void settle(patched, rt).finally(() => { rt.busy = false; });
        }
        for (const p of (get(e.id)?.participantMemories || [])) {
            if (!p.social) continue;
            const pRetryC = ["error", "interrupted"].includes(p.social.contactState);
            const pRetryM = ["error", "interrupted"].includes(p.social.momentState);
            if (!pRetryC && !pRetryM) continue;
            const pLive = live.get(p.social.id); if (pLive) { pLive.controller.abort(); live.delete(p.social.id); }
            const updatedActor = update(p.social.id, {
                ...(pRetryC ? { contactState: "pending", contactError: undefined } : {}),
                ...(pRetryM ? { momentState: "pending", momentError: undefined } : {}),
            });
            if (updatedActor) {
                const prt = runtime(updatedActor);
                prt.busy = true;
                prt.nextAt = Infinity;
                prt.contactPlanned = !pRetryC;
                void settle(updatedActor, prt).finally(() => { prt.busy = false; });
            }
        }
        return get(e.id);
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
        void writeParticipantMemories(ended);
        const rt = runtime(ended); rt.busy = true; rt.nextAt = Infinity;
        void settle(ended, rt).finally(() => { rt.busy = false; });
        return get(e.id);
    }
    throw new Error("未知兄弟局操作。");
}
