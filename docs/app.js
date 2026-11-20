import { dialogueIntervals, dialogueOffset, overlapsDialogue, songGaps } from "./caption-alignment.js";
import { fetchCaptions, parseCaptions, suggestedWindow, lyricWindows, windowCaptions } from "./jimaku.js";
import { rubyMarkup } from "./furigana.js";
import { timestamp, clock, parseLrc, makeDraft, estimatePlainStart, fillMissingTimes,
    originalAss, validatedCues, mergedAss } from "./timing.js";
import { readWhisperTiming, whisperDraft } from "./whisper.js";

const $ = id => document.getElementById(id);
const player = $("player");
const defaultSongDuration = 94_000;
const client = "AI-OPED-Merger/0.1.1 (https://github.com/randoomdude/AI-OPED-Merger)";
const catalog = await fetch("./example-themes.json", { cache: "no-cache" })
    .then(response => response.json()).catch(() => null);
const shows = Array.isArray(catalog) ? catalog : catalog ? [catalog] : [];
const animeTitleCache = new Map();
let episode;
let selectedTrack;
let localDialogue = [];
const trackGaps = { OP: [], ED: [] };
let pendingSeek;
let worker;
let previewUrl;
let slot = "OP";
let slots;
let sourceRequest;
let jimakuRequest;
let retryAt = 0;

function status(message, error = false) {
    $("status").textContent = message;
    $("status").classList.toggle("error", error);
}

function text(tag, content, className) {
    const node = document.createElement(tag);
    node.textContent = content;
    if (className) node.className = className;
    return node;
}

function option(label, value) {
    const node = text("option", label);
    node.value = value;
    return node;
}

function setPreview(file) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const input = /\.mkv$/i.test(file.name) ? file.slice(0, file.size, "video/x-matroska") : file;
    previewUrl = URL.createObjectURL(input);
    $("playback-note").textContent = "";
    pendingSeek = null;
    player.src = previewUrl;
}

function chapterFor(name) {
    const pattern = name === "OP"
        ? /^(?:(?:op|opening(?: credits)?|intro)(?:\s*\d+)?|オープニング)$/i
        : /^(?:(?:ed|ending(?: credits)?|credits|end credits)(?:\s*\d+)?|エンディング)$/i;
    return episode.chapters.find(chapter => pattern.test(chapter.title.trim()));
}

function titleKey(title) {
    return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function catalogShow(title) {
    const key = titleKey(title);
    return shows.find(entry => entry.aliases.some(alias => titleKey(alias) === key));
}

function titleWithoutYear(title) {
    return title.normalize("NFKC").replace(/\s*\((?:19|20)\d{2}\)$/, "").trim();
}

function showForSearch(state, query) {
    const known = catalogShow(query);
    if (known) return known;
    const localShow = catalogShow(state.anime);
    const matchesSong = [state.song?.search_query, state.song?.title].includes(query);
    const matchesUnqualifiedTitle = localShow?.aliases.some(alias =>
        titleKey(titleWithoutYear(alias)) === titleKey(query));
    return matchesSong || matchesUnqualifiedTitle ? localShow : null;
}

function stateFor(name) {
    const chapter = chapterFor(name);
    const { anime } = episode;
    const show = catalogShow(anime);
    const song = show?.songs.find(item => item.slot === name) || null;
    return {
        chapter, anime, song, windowStart: clock(chapter?.start), windowEnd: "",
        query: song?.search_query || song?.title || anime, alternates: "", source: null, lines: [], rows: [],
        first: 0, last: 0, second: null, firstEpisode: "", secondEpisode: "",
        secondMode: "drift", beforeCutEnd: "",
    };
}

function timingDefaults(state, fallbackStart = NaN) {
    const start = state.windowStart.trim() ? timestamp(state.windowStart) : fallbackStart;
    const chapterEnd = state.chapter?.end;
    const end = Math.min(start + defaultSongDuration, episode.duration ?? Infinity,
        chapterEnd > start ? chapterEnd : Infinity);
    const firstEpisode = start + Math.max(0, state.lines[state.first]?.time ?? NaN);
    return { start, end, firstEpisode };
}

function showTimingDefaults() {
    const defaults = timingDefaults(slots[slot]);
    $("window-end").placeholder = clock(defaults.end) || "Up to 1:34 after episode start";
    $("first-episode").placeholder = clock(defaults.firstEpisode) || "Set the episode start first";
}

function showSecondAnchor() {
    const state = slots[slot];
    $("second-options").hidden = state.second === null;
    $("cut-options").hidden = state.secondMode !== "shift";
}

function trackChanged() {
    selectedTrack = episode.tracks.find(track => track.number === Number($("track").value));
    localDialogue = dialogueIntervals(selectedTrack);
    for (const name of ["OP", "ED"]) {
        const state = slots[name];
        const gaps = selectedTrack.forced || /^(?:signs|songs|forced)$|\b(?:signs|songs) only\b/i.test(selectedTrack.name || "")
            ? [] : songGaps(localDialogue, name, episode.duration);
        trackGaps[name] = gaps;
        if (state.chapter || state.windowOrigin === "manual" ||
            (state.windowStart || state.windowEnd) && state.windowOrigin !== "a gap in MKV dialogue") continue;
        const same = gaps.find(g => g.start === timestamp(state.windowStart));
        const possible = gaps.filter(g => g.end - g.start <= 125_000);
        const gap = same || (gaps.length === 1 ? gaps[0] : possible.length === 1 ? possible[0] : null);
        if (gap) useGap(state, gap);
        else if (state.windowOrigin === "a gap in MKV dialogue") {
            state.windowStart = state.windowEnd = state.windowOrigin = "";
        }
    }
    syncWindowFields();
    renderCaptionPreview();
    const styleCount = (selectedTrack.header.match(/^Style:/gm) || []).length;
    $("track-summary").textContent = selectedTrack.cues.length + " subtitle events · " + styleCount
        + " ASS styles · " + episode.fonts.length + " attached fonts";
}

function showSlot() {
    sourceRequest?.abort();
    const state = slots[slot];
    $("window-start").value = state.windowStart;
    $("window-end").value = state.windowEnd;
    showWindowNote();
    $("query").value = state.query;
    $("alternates").value = state.alternates;
    $("alternates").placeholder = catalogShow(state.anime)?.aliases.join("\n") || "One alternate title per line";
    $("alternate-titles").open = Boolean(state.alternates);
    $("source-url").value = state.source?.url || state.song?.sources.uta_net || "";
    $("paste").value = "";
    showSourceLinks();
    renderCaptionPreview();
    $("search-status").textContent = "";
    $("results").replaceChildren();
    showTiming();
}

function showSourceLinks() {
    const state = slots[slot];
    const query = state.query.trim();
    const song = showForSearch(state, query)?.songs.find(item => item.slot === slot) ?? state.song;
    $("song-title").textContent = song ? song.title + " · " + song.artist : "";
    for (const [id, key, name, searchUrl] of [
        ["uta-net", "uta_net", "Uta-Net", "https://www.uta-net.com/"],
        ["uta-ten", "uta_ten", "UtaTen", query
            ? "https://utaten.com/lyric/search?" + new URLSearchParams({ title: query })
            : "https://utaten.com/search"],
    ]) {
        const link = $(id);
        const songPage = song?.sources[key];
        link.href = songPage || searchUrl;
        link.textContent = songPage ? name + " lyrics" : "Search " + name;
        link.onclick = () => {
            if (songPage) $("source-url").value = songPage;
            $("paste-lyrics").open = true;
        };
    }
}

const nativeView = window.chrome?.webview;
let desktop = false;
const pendingJobs = new Map();
if (nativeView) {
    nativeView.addEventListener("message", ({ data }) => {
        if (data?.opedDesktop === true) {
            desktop = true;
            $("intro").textContent = "Time opening and ending lyrics and save a new MKV with the merged subtitle track.";
            $("filename").textContent = "Choose an episode from this PC.";
            $("helper-instructions").hidden = true;
            $("run-whisper").hidden = $("export-mkv").hidden = false;
            $("jimaku-whisper").textContent = "Use Whisper on this song";
        } else if (pendingJobs.has(data?.id)) {
            const job = pendingJobs.get(data.id);
            pendingJobs.delete(data.id);
            if (data.error) job.reject(Error(data.error));
            else job.resolve(data.value);
        }
    });
    nativeView.postMessage({ action: "oped_ready" });
}

function desktopJob(action, ...args) {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pendingJobs.set(id, { resolve, reject });
        nativeView.postMessage({ id, action, args });
    });
}

function loadEpisode(file) {
    const desktopId = desktop ? crypto.randomUUID() : null;
    if (desktopId) nativeView.postMessageWithAdditionalObjects({ action: "episode", id: desktopId }, [file]);
    worker?.terminate();
    sourceRequest?.abort();
    jimakuRequest?.abort();
    clearCaptionPreview();
    $("furigana-mode").value = "above";
    episode = null;
    $("project").hidden = true;
    $("track-options").hidden = true;
    $("filename").textContent = file.name;
    $("progress").value = 0;
    $("progress").hidden = false;
    status("Reading the MKV…");
    const active = new Worker("./extract.js");
    worker = active;
    function fail(message) {
        active.terminate();
        $("progress").hidden = true;
        status(message, true);
    }
    active.onerror = event => fail(event.message || "The MKV reader could not start.");
    active.onmessage = ({ data }) => {
        if (data.error) return fail(data.error);
        if (typeof data.progress === "number") {
            $("progress").value = data.progress;
            return;
        }
        const filename = file.name.replace(/^(?:\[[^\]]+\]\s*)+/, "").replace(/\.mkv$/i, "");
        const match = filename.match(/^(.+?)(?:\s+-\s+(\d+(?:\.\d+)?)(?:v\d+)?(?=\s|\[|\(|$)|[ ._-]+S\d+E(\d+)\b)/i);
        const number = Number(match?.[2] ?? match?.[3]);
        episode = { ...data, file, desktopId, number, anime: match?.[1] || filename };
        $("jimaku-title").value = episode.anime;
        $("jimaku-episode").value = Number.isInteger(number) ? String(number) : "";
        $("jimaku-status").textContent = "";
        $("jimaku-results").replaceChildren();
        showJimakuLink();
        active.terminate();
        $("progress").hidden = true;
        slots = { OP: stateFor("OP"), ED: stateFor("ED") };
        const tracks = episode.tracks;
        const english = tracks.filter(track => /^(en|eng)(-|$)/i.test(track.language || "") &&
            !track.forced && !/\b(signs|songs|forced)\b/i.test(track.name || ""));
        const defaults = english.filter(track => track.default);
        const track = defaults.length === 1 ? defaults[0] : english.length === 1 ? english[0] : tracks[0];
        $("track").replaceChildren(...tracks.map(item => option(
            (item.name || "Track " + item.number) + " · " + (item.language || "und") + " · " + item.cues.length + " cues", item.number)));
        $("track").value = track.number;
        trackChanged();
        slot = $("slot").value = "OP";
        $("project").hidden = false;
        $("track-options").hidden = false;
        setPreview(file);
        showSlot();
        status(english.length === 1 || defaults.length === 1
            ? "Episode ready. Choose the song and find its lyrics."
            : "Episode ready. Check which subtitle track you want to merge.");
    };
    active.postMessage(file);
}

$("episode").addEventListener("change", event => {
    const file = event.target.files[0];
    if (!file) return;
    if (slots && Object.values(slots).some(state => state.source) &&
        !window.confirm("Open another episode? Save a project ZIP first if you need to keep the current draft.")) {
        event.target.value = "";
        return;
    }
    loadEpisode(file);
});
$("track").addEventListener("change", trackChanged);
$("slot").addEventListener("change", event => { slot = event.target.value; showSlot(); });
$("preview").addEventListener("change", event => { if (event.target.files[0]) setPreview(event.target.files[0]); });
player.addEventListener("timeupdate", () => { $("playhead").textContent = clock(player.currentTime * 1000); });
player.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(pendingSeek)) seek(pendingSeek);
    if (episode?.duration && Number.isFinite(player.duration) && Math.abs(player.duration * 1000 - episode.duration) > 1500) {
        $("playback-note").textContent = "The preview duration differs from the MKV. Check that their timelines match.";
    }
});
player.addEventListener("error", () => {
    $("playback-note").textContent = "This file could not play in your browser. Use a matching preview file or enter times from your video player.";
});

function seek(ms) {
    if (!Number.isFinite(ms)) return;
    if (player.error) return status("The preview cannot play this MKV. Load a matching preview to jump to " + clock(ms) + ".", true);
    if (!player.readyState) {
        pendingSeek = ms;
        return status("Waiting for the preview to load at " + clock(ms) + ".");
    }
    pendingSeek = null;
    player.currentTime = Math.max(0, ms / 1000);
    $("playhead").textContent = clock(player.currentTime * 1000);
}
$("jump").onclick = () => {
    const start = timestamp(slots[slot].windowStart);
    if (Number.isFinite(start)) return seek(start);
    $("window-start").focus();
    status("The song start is unknown. Check a Jimaku subtitle file or enter an episode start.", true);
};
$("back").onclick = () => seek(player.currentTime * 1000 - 2000);
$("forward").onclick = () => seek(player.currentTime * 1000 + 2000);
for (const [id, key] of [["query", "query"], ["alternates", "alternates"], ["window-start", "windowStart"], ["window-end", "windowEnd"],
    ["first-episode", "firstEpisode"], ["second-episode", "secondEpisode"], ["before-cut-end", "beforeCutEnd"]]) {
    $(id).addEventListener("input", event => { slots[slot][key] = event.target.value; });
}
$("query").addEventListener("input", showSourceLinks);
$("window-start").addEventListener("input", showTimingDefaults);
for (const id of ["window-start", "window-end"]) $(id).addEventListener("input", () => {
    slots[slot].windowOrigin = "manual";
    showWindowNote();
    renderCaptionPreview();
});
for (const key of ["first", "last", "second"]) {
    $(key).addEventListener("change", event => {
        slots[slot][key] = event.target.value === "" ? null : Number(event.target.value);
    });
}
$("first").addEventListener("change", showTimingDefaults);
$("second").addEventListener("change", showSecondAnchor);
$("second-mode").addEventListener("change", event => {
    slots[slot].secondMode = event.target.value;
    showSecondAnchor();
});
for (const button of document.querySelectorAll("[data-capture]")) {
    button.onclick = () => {
        if (!player.readyState) return status("Load a playable preview before capturing the playhead.", true);
        const input = $(button.dataset.capture);
        input.value = clock(player.currentTime * 1000);
        input.dispatchEvent(new Event("input"));
    };
}

function beginSourceRequest() {
    sourceRequest?.abort();
    sourceRequest = new AbortController();
    return sourceRequest.signal;
}

async function lrclib(path, signal) {
    signal.throwIfAborted();
    if (Date.now() < retryAt) throw Error("LRCLIB asked this app to wait. Retry in " + Math.ceil((retryAt - Date.now()) / 1000) + " seconds.");
    const timeout = AbortSignal.timeout(20000);
    try {
        const response = await fetch("https://lrclib.net" + path, {
            headers: { "Lrclib-Client": client }, signal: AbortSignal.any([signal, timeout]),
        });
        if (response.status === 429 || response.status === 503) {
            const retry = response.headers.get("Retry-After");
            const delay = /^\d+$/.test(retry || "") ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
            retryAt = Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60000);
            throw Error("LRCLIB is busy. Retry in " + Math.ceil((retryAt - Date.now()) / 1000) + " seconds.");
        }
        if (!response.ok) throw Error("LRCLIB returned HTTP " + response.status + ".");
        return await response.json();
    } catch (error) {
        signal.throwIfAborted();
        if (timeout.aborted) throw Error("LRCLIB took too long to respond.");
        if (error instanceof TypeError) throw Error("Could not reach LRCLIB. Try again or paste the source lyrics.");
        throw error;
    }
}

async function animeTitles(query, signal) {
    const title = titleWithoutYear(query);
    const year = Number(query.normalize("NFKC").match(/\((\d{4})\)$/)?.[1]);
    const key = titleKey(query);
    if (animeTitleCache.has(key)) return animeTitleCache.get(key);
    try {
        const response = await fetch("https://graphql.anilist.co", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: "query($title:String){Page(perPage:8){media(type:ANIME,search:$title){seasonYear title{english romaji native} synonyms}}}",
                variables: { title },
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) return [];
        const { data } = await response.json();
        if (!Array.isArray(data?.Page?.media)) return [];
        const matches = data.Page.media.filter(media =>
            (!year || media.seasonYear === year) && [...Object.values(media.title), ...media.synonyms].some(name =>
                name && titleKey(titleWithoutYear(name)) === titleKey(title)));
        const titles = matches.length === 1 ? Object.values(matches[0].title).filter(Boolean) : [];
        animeTitleCache.set(key, titles);
        return titles;
    } catch {
        signal.throwIfAborted();
        return [];
    }
}

async function searchLyrics(variants, signal) {
    const queries = new Set(variants.map(params => new URLSearchParams(params).toString()));
    const records = new Map();
    let failure;
    for (const query of queries) {
        try {
            const results = await lrclib("/api/v2/search?" + query, signal);
            for (const record of results) {
                if (Number.isInteger(record.id) && (record.hasPlainLyrics || record.hasSyncedLyrics)) records.set(record.id, record);
            }
        } catch (error) {
            signal.throwIfAborted();
            failure = error;
            if (Date.now() < retryAt) break;
        }
    }
    if (!records.size && failure) throw failure;
    return [...records.values()];
}

function animeQueries(titles) {
    return [...new Set(titles.map(titleWithoutYear))].map(q => ({ q }));
}

function uniqueTitles(titles) {
    const unique = new Map();
    for (const term of titles) {
        const title = term.trim();
        const key = title.normalize("NFKC").toLowerCase();
        if (key && !unique.has(key)) unique.set(key, title);
    }
    return [...unique.values()];
}

function alternateTitles(state) {
    return uniqueTitles(state.alternates.split(/\r?\n/));
}

let captionFile;
let captionRequest;

function clearCaptionPreview() {
    captionRequest?.abort();
    captionFile = null;
    $("jimaku-preview").replaceChildren();
}

function songWindow() {
    const state = slots[slot];
    const { start, end: defaultEnd } = timingDefaults(state);
    const end = state.windowEnd.trim() ? timestamp(state.windowEnd) : defaultEnd;
    const duration = episode.duration ?? Infinity;
    // Older projects stored end times rounded to centiseconds. Snap that last display tick to EOF.
    const clipEnd = Math.min(end, duration);
    return [start, end].every(Number.isFinite) && start >= 0 && clipEnd > start && end <= Math.max(duration, Math.round(duration), Math.round(duration / 10) * 10)
        ? { start, end: clipEnd } : null;
}

async function checkCaptions(file, url, signal, selected = false) {
    clearCaptionPreview();
    captionRequest = new AbortController();
    const checking = AbortSignal.any([signal, captionRequest.signal]);
    const area = $("jimaku-preview");
    area.textContent = "Reading " + file.name + "…";
    try {
        const data = await fetchCaptions(url, checking);
        if (checking.aborted) return;
        captionFile = { name: file.name, url, cues: parseCaptions(data, file.name) };
        if (selected || (Number.isFinite(episode.number) && $("jimaku-episode").value.trim() === String(episode.number))) {
            for (const name of ["OP", "ED"]) {
                const state = slots[name];
                if (state.windowStart || state.windowEnd || state.windowOrigin === "manual" || state.chapter) continue;
                const offset = fileOffset(state, captionFile);
                const markers = suggestedWindow(captionFile.cues, name, episode.duration, offset);
                const lyrics = markers ? [] : lyricWindows(captionFile.cues.map(c => ({
                    ...c, start: c.start + offset, end: c.end + offset,
                })), name, episode.duration);
                if (markers || lyrics.length === 1) {
                    useWindow(state, markers || lyrics[0], markers ? "Jimaku music markers" : "Jimaku lyric lines");
                    state.jimakuSync = { url: captionFile.url, offset };
                }
            }
            syncWindowFields();
        }
        renderCaptionPreview();
    } catch (error) {
        if (!checking.aborted) area.textContent = "Couldn’t read this subtitle file. " + error.message;
    }
}

function syncWindowFields() {
    const state = slots[slot];
    $("window-start").value = state.windowStart;
    $("window-end").value = state.windowEnd;
    showWindowNote();
    showTimingDefaults();
}

function showWindowNote() {
    const state = slots[slot];
    const options = $("gap-options");
    options.replaceChildren();
    const gaps = trackGaps[slot];
    if (!state.chapter && gaps.length && (gaps.length > 1 || state.windowOrigin !== "a gap in MKV dialogue")) {
        const label = text("label", "Possible " + slot + " gaps in the selected MKV dialogue track");
        const select = document.createElement("select");
        select.append(option("Choose a gap", ""), ...gaps.map((g, i) =>
            option(clock(g.start) + " – " + clock(g.end) + " (" + ((g.end - g.start) / 1000).toFixed(1) + " s)", i)));
        select.onchange = () => {
            if (!select.value) return;
            useGap(state, gaps[Number(select.value)]);
            syncWindowFields();
            renderCaptionPreview();
        };
        label.append(select);
        options.append(label);
    }
    $("chapter-note").textContent = state.windowOrigin === "a gap in MKV dialogue"
        ? "Estimated from a gap longer than 1:30 in the selected MKV dialogue track. Check Jimaku to refine the timing."
        : state.windowOrigin && state.windowOrigin !== "manual" ? "Song window from " + state.windowOrigin + "."
        : state.chapter && state.windowStart === clock(state.chapter.start) ? "Song start from the MKV chapter named " + state.chapter.title + "."
        : state.windowStart ? "Song start set to " + state.windowStart + "." : "Set the song start or check an episode subtitle file on Jimaku.";
}

function useGap(state, gap) {
    useWindow(state, { start: gap.start, end: Math.min(gap.end, gap.start + defaultSongDuration) }, "a gap in MKV dialogue");
}

function useWindow(state, range, origin) {
    state.windowStart = clock(range.start, 3);
    state.windowEnd = clock(range.end, 3);
    state.windowOrigin = origin;
    state.windowFile = origin === "a gap in MKV dialogue" ? null : captionFile.url;
}

function fileOffset(state, file) {
    if (state.jimakuSync?.url === file.url) return state.jimakuSync.offset;
    if (state.source?.provider === "Jimaku" && state.source.url === file.url) return state.source.offset || 0;
    return 0;
}

function adjustFile(file, offset) {
    const state = slots[slot];
    if (!Number.isSafeInteger(offset) || Math.abs(offset) >= episode.duration)
        return status("Enter a timing offset in seconds within the episode length.", true);
    const marker = state.windowOrigin === "Jimaku music markers" && state.windowFile === file.url;
    const range = marker && suggestedWindow(file.cues, slot, episode.duration, offset);
    const shiftLyrics = state.windowOrigin === "Jimaku lyric lines" && state.windowFile === file.url;
    const lyricRange = shiftLyrics && { start: timestamp(state.windowStart) + offset - fileOffset(state, file),
        end: timestamp(state.windowEnd) + offset - fileOffset(state, file) };
    if (lyricRange && (lyricRange.start < 0 || lyricRange.end > episode.duration)) return status("That offset moves the lyrics outside the episode.", true);
    if (marker && !range) return status("That offset moves the song markers outside the episode.", true);
    if (state.source?.provider === "Jimaku" && state.source.url === file.url && !state.source.whisper) {
        const change = offset - (state.source.offset || 0);
        const shifted = state.rows.map(row => {
            const next = { ...row };
            for (const key of ["start", "end"]) {
                if (!row[key]?.trim()) continue;
                const value = timestamp(row[key]) + change;
                if (!Number.isFinite(value) || value < 0 || value > Math.ceil(episode.duration / 10) * 10) return null;
                next[key] = clock(value);
            }
            return next;
        });
        if (shifted.some(row => !row)) return status("That shift would move a draft line outside the episode or affect an invalid timestamp.", true);
        state.rows = shifted;
        state.source.offset = offset;
    }
    state.jimakuSync = { url: file.url, offset };
    if (range) useWindow(state, range, "Jimaku music markers");
    if (lyricRange) useWindow(state, lyricRange, "Jimaku lyric lines");
    syncWindowFields();
    showRows();
    renderCaptionPreview();
    status("Jimaku timing for " + slot + " adjusted by " + (offset / 1000) + " s.");
}

function showAlignment(area, file, offset, range) {
    const panel = document.createElement("details");
    panel.append(text("summary", "Adjust Jimaku timing to this MKV"));
    const label = text("label", "Jimaku offset in seconds (negative = earlier)");
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.001";
    input.value = offset / 1000;
    label.append(input);
    const apply = text("button", "Apply offset");
    apply.onclick = () => adjustFile(file, Math.round(input.valueAsNumber * 1000));
    panel.append(label, apply);
    if (range) {
        const compare = text("button", "Compare nearby dialogue times");
        panel.append(compare);
        compare.onclick = () => {
            const match = dialogueOffset(file.cues, localDialogue, { start: range.start - offset, end: range.end - offset });
            const note = match ? match.count + " nearby caption starts line up at " + match.offset / 1000 + " s. Review the offset and apply it."
                : "No clear shared offset within 20 seconds. Enter an offset measured against the episode audio.";
            if (match) input.value = match.offset / 1000;
            compare.replaceWith(text("p", note));
        };
    }
    area.append(panel);
}


function renderCaptionPreview() {
    if (!captionFile || !episode) return;
    const file = captionFile;
    const area = $("jimaku-preview");
    area.replaceChildren(text("strong", file.name));
    const range = songWindow();
    const state = slots[slot];
    const offset = fileOffset(state, file);
    const cues = offset ? file.cues.map(c => ({ ...c, start: c.start + offset, end: c.end + offset })) : file.cues;
    const suggestion = suggestedWindow(file.cues, slot, episode.duration, offset);
    const lyrics = suggestion ? [] : lyricWindows(cues, slot, episode.duration);
    const chapterStart = state.chapter && timestamp(state.windowStart) === timestamp(clock(state.chapter.start));
    const windows = chapterStart ? [] : suggestion ? [suggestion] : lyrics;
    for (const candidate of windows) {
        const origin = suggestion ? "Jimaku music markers" : "Jimaku lyric lines";
        if (state.windowOrigin === origin && state.windowFile === file.url && range && range.start === candidate.start && range.end === candidate.end) continue;
        const refine = state.windowOrigin === "a gap in MKV dialogue";
        const button = text("button", refine ? "Refine " + slot + " with Jimaku" : (suggestion ? "Use music markers for " : "Use timed lyric lines for ") + slot);
        button.onclick = () => {
            useWindow(state, candidate, origin);
            state.jimakuSync = { url: file.url, offset };
            syncWindowFields();
            renderCaptionPreview();
            seek(candidate.start);
        };
        area.append(text("p", (suggestion ? "Jimaku music markers" : "First and last marked lyric") + " from "
            + clock(candidate.start) + " to " + clock(candidate.end) + ". Check against your audio."), button);
    }
    showAlignment(area, file, offset, range || windows[0]);
    if (!range) {
        area.append(text("p", "Set the song window above to check for timed lines."));
        return;
    }
    const candidates = windowCaptions(cues, range.start, range.end);
    const period = slot + " (" + clock(range.start) + " – " + clock(range.end) + ")";
    if (!candidates.length) {
        area.append(text("p", "No lyric or dialogue lines in " + period + ". Try Whisper on the episode audio."));
        return;
    }
    area.append(text("p", candidates.length + " timed captions overlap " + period + ". Select the lyrics you hear."));
    const list = document.createElement("div");
    list.className = "caption-list";
    const filter = document.createElement("select");
    filter.setAttribute("aria-label", "Captions to show");
    filter.append(option("All Jimaku captions", "all"), option("Only captions without overlapping MKV dialogue", "missing"));
    const chosen = [];
    for (const cue of candidates) {
        const label = document.createElement("label");
        const check = document.createElement("input");
        check.type = "checkbox";
        const overlap = overlapsDialogue(cue, localDialogue);
        label.append(check, " " + clock(cue.start) + " – " + clock(cue.end) + "  " + cue.text
            + (overlap ? "" : " · No MKV dialogue"));
        list.append(label);
        chosen.push({ check, label, overlap });
    }
    const all = text("button", "Select all");
    const count = text("p", "");
    filter.onchange = () => {
        const missing = filter.value === "missing";
        for (const { label, overlap, check } of chosen) {
            label.hidden = missing && overlap;
            if (label.hidden) check.checked = false;
        }
        count.textContent = missing ? chosen.filter(item => !item.overlap).length + " captions without overlapping dialogue on the selected MKV track." : "";
        all.textContent = "Select all";
    };
    all.onclick = () => {
        const visible = chosen.filter(item => !item.label.hidden);
        const select = visible.some(item => !item.check.checked);
        for (const { check } of visible) check.checked = select;
        all.textContent = select ? "Clear selection" : "Select all";
    };
    const apply = text("button", "Import selected lines");
    apply.onclick = () => {
        const rows = candidates.filter((_, i) => chosen[i].check.checked).map(cue => ({
            text: cue.text, start: clock(cue.start), end: clock(cue.end), include: true,
        }));
        if (!rows.length) return status("Select at least one Jimaku caption to import.", true);
        if (!setSource({ provider: "Jimaku", title: file.name, url: file.url, offset, synced: "",
            plain: rows.map(row => row.text).join("\n") })) return;
        sourceRequest?.abort();
        slots[slot].rows = rows;
        $("source-url").value = file.url;
        showTiming();
        status("Imported " + rows.length + " timed Jimaku lines into " + slot + ".");
    };
    area.append(filter, count, list, all, apply);
}


function showJimakuLink() {
    const title = $("jimaku-title").value.trim();
    const id = catalogShow(title)?.jimaku_id;
    $("jimaku-public").href = id ? "https://jimaku.cc/entry/" + id : title
        ? "https://jimaku.cc/opensearch/redirect?" + new URLSearchParams({ anime: true, query: title })
        : "https://jimaku.cc/";
}

for (const id of ["jimaku-title", "jimaku-episode"]) {
    $(id).addEventListener("input", () => {
        jimakuRequest?.abort();
        clearCaptionPreview();
        $("jimaku-status").textContent = "";
        $("jimaku-results").replaceChildren();
        showJimakuLink();
    });
}

async function jimaku(path, key, signal) {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(15000);
    let response;
    try {
        response = await fetch("https://jimaku.cc/api" + path, {
            headers: { Authorization: key }, credentials: "omit", redirect: "error",
            signal: AbortSignal.any([signal, timeout]),
        });
    } catch {
        signal.throwIfAborted();
        throw Error(timeout.aborted ? "Jimaku took too long to respond." : "Could not reach Jimaku. Try Browse on Jimaku.");
    }
    if (response.status === 401 || response.status === 403) throw Error("Jimaku rejected the API key. Check it in your Jimaku account.");
    if (response.status === 429) throw Error("Jimaku is limiting requests. Wait and try again.");
    if (!response.ok) throw Error("Jimaku returned HTTP " + response.status + ".");
    const data = await response.json();
    if (!Array.isArray(data)) throw Error("Jimaku returned an unexpected response.");
    return data;
}

async function listJimakuFiles(id, number, key, signal) {
    $("jimaku-status").textContent = "Looking for subtitle files…";
    $("jimaku-results").replaceChildren();
    const query = number === "" ? "" : "?" + new URLSearchParams({ episode: number });
    const files = await jimaku("/entries/" + id + "/files" + query, key, signal);
    if (signal.aborted) return;
    $("jimaku-public").href = "https://jimaku.cc/entry/" + id;
    let count = 0;
    const readable = [];
    for (const file of files) {
        if (typeof file?.name !== "string" || typeof file.url !== "string") continue;
        const url = URL.parse(file.url, "https://jimaku.cc");
        if (!url || url.origin !== "https://jimaku.cc" || !url.pathname.startsWith("/entry/" + id + "/download/")) continue;
        const row = text("div", "", "result");
        const link = text("a", file.name);
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        row.append(link);
        if (/\.(ass|ssa|srt)$/i.test(file.name)) {
            const check = text("button", "Check song lines");
            check.onclick = () => checkCaptions(file, url.href, signal, true);
            row.append(check);
            readable.push({ file, url });
        }
        $("jimaku-results").append(row);
        count++;
    }
    $("jimaku-status").textContent = count ? count + (count === 1 ? " subtitle file found. " : " subtitle files found. ")
        + (readable.length ? "Check timed captions for the selected song." : "Open the download to inspect this file format.")
        : number ? "Jimaku returned no files for episode " + number + ". Browse the entry for other releases."
            : "Jimaku returned no subtitle files for this title.";
    if (readable.length === 1) await checkCaptions(readable[0].file, readable[0].url.href, signal);
}

async function runJimakuSearch(entryId) {
    clearCaptionPreview();
    jimakuRequest?.abort();
    jimakuRequest = new AbortController();
    const { signal } = jimakuRequest;
    const title = $("jimaku-title").value.trim();
    const number = $("jimaku-episode").value.trim();
    const key = $("jimaku-key").value.trim();
    const knownId = catalogShow(title)?.jimaku_id;
    $("jimaku-results").replaceChildren();
    if (!title) return $("jimaku-status").textContent = "Enter an anime title.";
    if (!key) return $("jimaku-status").textContent = "Use Browse on Jimaku, or enter a Jimaku API key to list files here.";
    if (number && (!/^\d+$/.test(number) || Number(number) > 2147483647)) {
        return $("jimaku-status").textContent = "Enter a whole episode number or leave it blank to list all episodes.";
    }
    try {
        if (entryId || knownId) return await listJimakuFiles(entryId || knownId, number, key, signal);
        $("jimaku-status").textContent = "Searching Jimaku…";
        const entries = new Map();
        for (const query of uniqueTitles([title, ...alternateTitles(slots[slot])])) {
            const hits = await jimaku("/entries/search?" + new URLSearchParams({ anime: true, query }), key, signal);
            for (const entry of hits) {
                if (Number.isSafeInteger(entry?.id) && entry.id > 0 && typeof entry.name === "string") entries.set(entry.id, entry);
            }
        }
        if (signal.aborted) return;
        if (entries.size === 1) return await listJimakuFiles(entries.keys().next().value, number, key, signal);
        $("jimaku-status").textContent = entries.size ? "Choose an anime entry to view its episode files." : "Jimaku found no matching anime entries.";
        for (const entry of entries.values()) {
            const row = text("div", "", "result");
            const label = document.createElement("div");
            label.append(text("strong", entry.name));
            const names = uniqueTitles([entry.name, entry.english_name || "", entry.japanese_name || ""]);
            if (names.length > 1) label.append(text("span", names.slice(1).join(" · ")));
            const button = text("button", "List files");
            button.type = "button";
            button.onclick = () => runJimakuSearch(entry.id);
            row.append(label, button);
            $("jimaku-results").append(row);
        }
    } catch (error) {
        if (!signal.aborted) $("jimaku-status").textContent = error.message;
    }
}

$("jimaku-search").onclick = () => runJimakuSearch();

function setSource(source) {
    const state = slots[slot];
    if (state.rows.length && !window.confirm("Replace the lyrics and timing draft for this song?")) return false;
    state.source = source;
    state.lines = parseLrc(source.synced || "");
    state.rows = [];
    state.first = 0;
    state.last = Math.max(0, state.lines.length - 1);
    state.second = null;
    state.firstEpisode = "";
    state.secondEpisode = "";
    state.secondMode = "drift";
    state.beforeCutEnd = "";
    showTiming();
    return true;
}

$("search").onclick = async () => {
    const query = $("query").value.trim();
    const searching = slots[slot];
    const alternates = alternateTitles(searching);
    if (!query && !alternates.length) return status("Enter a song, artist, or anime title.", true);
    const show = showForSearch(searching, query);
    const song = show?.songs.find(item => item.slot === slot);
    const signal = beginSourceRequest();
    $("search-status").textContent = "Searching LRCLIB…";
    $("results").replaceChildren();
    try {
        let rows;
        if (song?.lrclib_search) {
            const variants = [song.lrclib_search, ...(song.lrclib_alternates ?? [])];
            rows = await searchLyrics([...variants, ...alternates.filter(q => q !== query).map(q => ({ q }))], signal);
            if (!rows.length && song.lrclib_alternates?.length) {
                const songTitles = [...new Set(variants.map(entry => entry.track_name))];
                const artists = variants.map(entry => titleKey(entry.artist_name));
                const candidates = [...animeQueries(show.aliases), ...songTitles.map(track_name => ({ track_name }))];
                rows = (await searchLyrics(candidates, signal)).filter(record =>
                    songTitles.some(title => titleKey(record.trackName).startsWith(titleKey(title))) && artists.includes(titleKey(record.artistName)));
            }
        } else {
            const titles = show?.aliases ?? (query ? await animeTitles(query, signal) : []);
            const queries = uniqueTitles([song?.search_query || query, ...alternates, ...titles.map(titleWithoutYear)]);
            rows = await searchLyrics(queries.map(q => ({ q })), signal);
        }
        if (signal.aborted || slots[slot] !== searching) return;
        rows.sort((a, b) => Number(b.id === song?.sources.lrclib_id) - Number(a.id === song?.sources.lrclib_id));
        $("search-status").textContent = rows.length
            ? "Choose the matching song and recording."
            : song ? "No LRCLIB match for " + song.title + " by " + song.artist + ". Try a lyrics source below."
                : "No lyrics found on LRCLIB. Try the song title or use another lyrics source below.";
        for (const record of rows) {
            const label = document.createElement("div");
            label.append(text("strong", record.trackName), text("span",
                [record.artistName, record.duration + " seconds", record.hasSyncedLyrics ? "Timed lyrics" : "Plain lyrics"].join(" · ")));
            if (record.albumName) label.append(text("span", record.albumName));
            const button = text("button", "Import");
            button.type = "button";
            button.setAttribute("aria-label", "Import " + record.trackName);
            button.onclick = async () => {
                const importing = beginSourceRequest();
                try {
                    $("search-status").textContent = "Importing lyrics…";
                    const result = await lrclib("/api/get/" + record.id, importing);
                    if (importing.aborted || slots[slot] !== searching) return;
                    if (result.id !== record.id || !(result.plainLyrics || result.syncedLyrics)) throw Error("The selected record has no lyrics.");
                    setSource({ provider: "LRCLIB", url: "https://lrclib.net/api/get/" + result.id,
                        title: result.trackName, artist: result.artistName, duration: result.duration,
                        plain: result.plainLyrics || "", synced: result.syncedLyrics || "" });
                    $("search-status").textContent = "";
                } catch (error) {
                    if (!importing.aborted) $("search-status").textContent = error?.message || "Import cancelled.";
                }
            };
            const row = document.createElement("div");
            row.className = "result";
            row.append(label, button);
            $("results").append(row);
        }
    } catch (error) {
        if (!signal.aborted) $("search-status").textContent = error?.message || "Search cancelled.";
    }
};

$("paste").addEventListener("paste", event => {
    const html = event.clipboardData?.getData("text/html");
    if (!html || !/<ruby\b/i.test(html)) return;
    event.preventDefault();
    const box = event.currentTarget;
    box.setRangeText(rubyMarkup(html), box.selectionStart, box.selectionEnd, "end");
});
$("use-paste").onclick = () => {
    try {
        const source = $("source-url").value.trim();
        const url = source ? new URL(source) : null;
        const plain = rubyMarkup($("paste").value.trim());
        if ((url && !["https:", "http:"].includes(url.protocol)) || !plain) throw Error();
        const lines = parseLrc(plain);
        setSource({ provider: "Pasted text", url: url?.href ?? "", plain: lines.length ? "" : plain, synced: lines.length ? plain : "" });
    } catch {
        status("Enter lyrics. If you include a source URL, use a complete http or https address.", true);
    }
};

function plainRows(text) {
    return text.split(/\r?\n/).filter(line => line.trim()).map(line =>
        ({ text: line.trim(), start: "", end: "", include: true }));
}

$("import-whisper").onchange = async event => {
    const file = event.target.files[0];
    if (!episode || !file) return;
    event.target.value = "";
    await applyWhisper(async () => {
        if (file.size > 2 * 1024 * 1024) throw Error("Choose the small timing JSON file produced by the helper.");
        return JSON.parse(await file.text());
    });
};

$("run-whisper").onclick = async () => {
    const range = songWindow();
    if (!range) {
        $("window-start").focus();
        return status("Set the song window or choose the Jimaku music markers before running Whisper.", true);
    }
    const { start, end } = range;
    const button = $("run-whisper");
    const progress = $("whisper-progress");
    button.disabled = $("jimaku-whisper").disabled = $("export-mkv").disabled = true;
    progress.hidden = false;
    progress.textContent = "Listening to the " + slot + " from " + clock(start) + " to " + clock(end)
        + " on this PC. The first run can take several minutes.";
    try {
        await applyWhisper(() => desktopJob("time_song", episode.desktopId, slot, start, end));
    } finally {
        progress.hidden = true;
        button.disabled = $("jimaku-whisper").disabled = $("export-mkv").disabled = false;
    }
};

$("jimaku-whisper").onclick = () => {
    $("audio-options").open = true;
    if (desktop) $("run-whisper").click();
    else $("audio-options").scrollIntoView({ block: "center" });
};

async function applyWhisper(read) {
    const opened = episode;
    const selected = slot;
    const state = slots[selected];
    const source = state.source;
    const snapshot = JSON.stringify(state);
    try {
        const input = await read();
        if (episode !== opened || slot !== selected || slots[selected] !== state || JSON.stringify(state) !== snapshot) {
            return status("The episode, song, or draft changed while Whisper timing was loading. Run it again for the current selection.");
        }
        const data = readWhisperTiming(input, opened.file, selected, opened.duration);
        const reference = state.rows.length ? state.rows : state.lines.length
            ? plainRows(state.lines.slice(state.first, state.last + 1).map(line => line.text).join("\n"))
            : plainRows(source?.plain ?? "");
        const { rows, matched } = whisperDraft(data, reference);
        if (!matched) throw Error(reference.length
            ? "Whisper couldn’t match any of these lyrics. Check the song window and the lyrics."
            : "Whisper didn’t return any usable timestamps in this window.");
        if (state.rows.length && !window.confirm("Update this draft with the Whisper timestamps? Unmatched lyrics stay in the editor unchecked.")) return;
        sourceRequest?.abort();
        state.source = { ...(source ?? { provider: "Local Whisper", url: "", plain: rows.map(row => row.text).join("\n"), synced: "" }),
            whisper: true };
        state.rows = rows;
        state.windowStart ||= clock(data.start_ms, 3);
        state.windowEnd ||= clock(data.end_ms, 3);
        $("window-start").value = state.windowStart;
        $("window-end").value = state.windowEnd;
        showTiming();
        const total = reference.filter(row => row.include).length;
        status(reference.length
            ? "Whisper timed " + matched + " of " + total + " selected lines. Review the draft before exporting."
            : "Whisper draft imported with " + matched + " timed cues. Review the words and timing before exporting.");
    } catch (error) {
        status(error instanceof SyntaxError ? "Choose a valid timing JSON file from the Whisper helper." : error.message, true);
    }
}

function showTiming() {
    const state = slots[slot];
    $("timing").hidden = !state.source;
    $("source-status").textContent = state.source ? (state.source.title || state.source.provider)
        + " · " + (state.source.whisper ? "Timing from episode audio"
            : state.source.provider === "Jimaku" ? "Episode subtitle timing" : state.lines.length ? state.lines.length + " timed source lines" : "Manual timing") : "";
    const timed = Boolean(state.lines.length);
    $("anchors").hidden = !timed;
    $("plain-hint").hidden = timed || state.source?.whisper === true || state.source?.provider === "Jimaku";
    $("draft").hidden = ["Local Whisper", "Jimaku"].includes(state.source?.provider);
    if (timed) {
        for (const key of ["first", "last", "second"]) {
            $(key).replaceChildren(...state.lines.map((line, index) =>
                option(clock(line.time) + " · " + line.text, index)));
            if (key === "second") $(key).prepend(option("None", ""));
            $(key).value = state[key] ?? "";
        }
        $("first-episode").value = state.firstEpisode;
        $("second-episode").value = state.secondEpisode;
        $("second-mode").value = state.secondMode;
        $("before-cut-end").value = state.beforeCutEnd;
    }
    showTimingDefaults();
    showSecondAnchor();
    showRows();
}

function showRows() {
    const state = slots[slot];
    const rows = state.rows;
    $("fill-times").hidden = !rows.length || Boolean(state.lines.length);
    $("cue-list").replaceChildren();
    rows.forEach((row, index) => {
        const wrap = document.createElement("div");
        wrap.className = "cue";
        const body = document.createElement("div");
        const label = text("label", "Include line " + (index + 1), "inline");
        const include = document.createElement("input");
        include.type = "checkbox";
        include.checked = row.include;
        include.onchange = () => { row.include = include.checked; showExportSummary(); };
        label.prepend(include);
        const lyric = document.createElement("textarea");
        lyric.rows = 2;
        lyric.value = row.text;
        lyric.setAttribute("aria-label", "Lyric line " + (index + 1));
        lyric.oninput = () => { row.text = lyric.value; };
        body.append(label, lyric);
        wrap.append(body);
        for (const key of ["start", "end"]) {
            const container = text("label", key === "start" ? "Start" : "End");
            const input = document.createElement("input");
            input.value = row[key];
            input.setAttribute("aria-label", key + " for line " + (index + 1));
            input.oninput = () => { row[key] = input.value; };
            const capture = text("button", "Use playhead");
            capture.type = "button";
            capture.onclick = () => {
                if (!player.readyState) return status("Load a playable preview before capturing the playhead.", true);
                input.value = row[key] = clock(player.currentTime * 1000);
            };
            container.append(input, capture);
            if (key === "start") {
                const jump = text("button", "Go to line");
                jump.type = "button";
                jump.onclick = () => seek(timestamp(row.start));
                container.append(jump);
            }
            wrap.append(container);
        }
        $("cue-list").append(wrap);
    });
    showExportSummary();
}

function fillPlainRows(state, rows) {
    const defaults = timingDefaults(state, estimatePlainStart(rows));
    const end = state.windowEnd.trim() ? timestamp(state.windowEnd) : defaults.end;
    return fillMissingTimes(rows, { start: defaults.start, end: Math.min(end, episode.duration ?? Infinity) });
}

function hasMissingPlainTimes(state) {
    return !state.lines.length && state.rows.some(row => row.include && (!row.start.trim() || !row.end.trim()));
}

$("fill-times").onclick = () => {
    const state = slots[slot];
    if (!hasMissingPlainTimes(state)) return status("All included lines already have times.");
    try {
        state.rows = fillPlainRows(state, state.rows);
        showRows();
        status("Missing times filled. Listen through and adjust the estimates.");
    } catch (error) {
        status(error.message, true);
    }
};

$("draft").onclick = () => {
    const state = slots[slot];
    if (state.rows.length && !window.confirm("Rebuild this song’s draft and replace its line edits?")) return;
    try {
        const defaults = timingDefaults(state);
        state.rows = state.lines.length ? makeDraft(state.lines, {
            first: state.first, last: state.last, second: state.second,
            firstEpisode: state.firstEpisode.trim() ? timestamp(state.firstEpisode) : defaults.firstEpisode,
            secondEpisode: timestamp(state.secondEpisode), secondMode: state.secondMode,
            beforeCutEnd: state.beforeCutEnd.trim() ? timestamp(state.beforeCutEnd) : null,
            start: defaults.start,
            end: state.windowEnd.trim() ? timestamp(state.windowEnd) : defaults.end,
        }) : fillPlainRows(state, plainRows(state.source.plain));
        delete state.source.whisper;
        showTiming();
        status(state.lines.length ? "Draft created. Listen through and adjust its cues."
            : "Draft created with estimated times. Listen through and adjust its cues.");
    } catch (error) {
        status(error.message, true);
    }
};

function showExportSummary() {
    const counts = Object.values(slots).map(state => state.rows.filter(row => row.include).length);
    $("export-summary").textContent = counts[0] + " opening lines · " + counts[1] + " ending lines selected";
}

function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportProject(zip, saveMkv = false) {
    try {
        const original = originalAss(selectedTrack);
        const rows = Object.fromEntries(Object.entries(slots).map(([key, state]) => [key,
            !zip && hasMissingPlainTimes(state) ? fillPlainRows(state, state.rows) : state.rows]));
        const name = episode.file.name.replace(/\.mkv$/i, "");
        let cues;
        try {
            cues = validatedCues(rows, episode.duration);
        } catch (error) {
            if (!zip) throw error;
            cues = null;
        }
        if (!zip) {
            if (!cues.length) throw Error("Time at least one lyric line to export merged subtitles.");
            const included = Object.entries(slots).filter(([, value]) => value.source && !value.rows.some(row => row.include));
            if (included.length && !window.confirm("Export without timed lyrics for " + included.map(([key]) => key).join(", ") + "?")) return;
            const ass = mergedAss(original, cues, $("furigana-mode").value);
            let saved;
            if (saveMkv) {
                $("jimaku-whisper").disabled = $("export-mkv").disabled = $("run-whisper").disabled = true;
                status("Choose where to save the new MKV.");
                try {
                    saved = await desktopJob("save_mkv", episode.desktopId, ass, selectedTrack.language);
                } finally {
                    $("jimaku-whisper").disabled = $("export-mkv").disabled = $("run-whisper").disabled = false;
                }
                if (!saved) return status("Save canceled.");
                status("Saved " + saved.path + (saved.warnings.length ? " · " + saved.warnings.join(" ") : ""));
                return;
            }
            download(name + ".oped.ass", ass, "text/plain;charset=utf-8");
            const filled = Object.entries(rows).filter(([key, draft]) => slots[key].rows !== draft);
            for (const [key, draft] of filled) slots[key].rows = draft;
            if (filled.length) showRows();
            status(filled.length ? "Merged ASS exported with estimated times for blank fields." : "Merged ASS exported.");
            return;
        }
        const pack = {
            "original.ass": fflate.strToU8(original),
            "project.json": fflate.strToU8(JSON.stringify({
                version: 1, mkv: episode.file.name, mkv_size: episode.file.size,
                track: selectedTrack.number, duration_ms: episode.duration,
                chapters: episode.chapters, songs: slots, furigana: $("furigana-mode").value,
            }, null, 2)),
        };
        if (cues?.length) pack["merged.ass"] = fflate.strToU8(mergedAss(original, cues, $("furigana-mode").value));
        episode.fonts.forEach((font, index) => {
            const name = font.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
            pack["fonts/" + String(index + 1) + "-" + name] = font.data;
        });
        download(name + ".oped.zip", fflate.zipSync(pack, { level: 0 }), "application/zip");
        status(cues?.length ? "Project ZIP exported with merged ASS." : "Project ZIP exported with original subtitles and draft data.");
    } catch (error) {
        status(error.message, true);
    }
}

$("export-mkv").onclick = () => exportProject(false, true);
$("export-ass").onclick = () => exportProject(false);
$("export-zip").onclick = () => exportProject(true);

$("restore").onchange = async event => {
    const file = event.target.files[0];
    const opened = episode;
    if (!file || !opened) return;
    event.target.value = "";
    try {
        if (file.size > 100 * 1024 * 1024) throw Error("Project ZIP exceeds 100 MB.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const files = fflate.unzipSync(bytes, { filter: (entry) => entry.name === "project.json" && entry.originalSize < 8 * 1024 * 1024 });
        const saved = JSON.parse(fflate.strFromU8(files["project.json"]));
        if (opened !== episode) return;
        if (saved.version !== 1 || saved.mkv !== episode.file.name || saved.mkv_size !== episode.file.size
            || saved.duration_ms !== episode.duration || !episode.tracks.some(track => track.number === saved.track)) {
            throw Error("Open the same MKV release before loading this project.");
        }
        const restored = {};
        for (const name of ["OP", "ED"]) {
            const song = saved.songs?.[name];
            if (!song || !Array.isArray(song.rows) || song.rows.length > 5000 ||
                song.rows.some(row => typeof row.text !== "string" || typeof row.start !== "string" ||
                    typeof row.end !== "string" || typeof row.include !== "boolean")) {
                throw Error("The ZIP does not contain a valid timing draft.");
            }
            const base = stateFor(name);
            for (const key of ["query", "alternates", "windowStart", "windowEnd", "firstEpisode", "secondEpisode", "beforeCutEnd"]) {
                if (typeof song[key] === "string") base[key] = song[key];
            }
            if (song.secondMode === "shift") base.secondMode = "shift";
            if (["Jimaku music markers", "Jimaku lyric lines", "a gap in MKV dialogue", "manual"].includes(song.windowOrigin)) {
                base.windowOrigin = song.windowOrigin;
                base.windowFile = song.windowFile;
            }
            if (typeof song.jimakuSync?.url === "string" && Number.isSafeInteger(song.jimakuSync.offset)) {
                base.jimakuSync = { url: song.jimakuSync.url, offset: song.jimakuSync.offset };
            }
            base.rows = song.rows;
            if (song.source && typeof song.source.plain === "string" && typeof song.source.synced === "string") {
                base.source = song.source;
                base.lines = parseLrc(song.source.synced);
                base.last = Math.max(0, base.lines.length - 1);
                for (const key of ["first", "last", "second"]) {
                    if (Number.isInteger(song[key]) && base.lines[song[key]]) base[key] = song[key];
                }
            }
            restored[name] = base;
        }
        if (Object.values(slots).some(state => state.source) &&
            !window.confirm("Replace the draft in this browser tab with the saved project?")) return;
        slots = restored;
        $("furigana-mode").value = ["above", "inline", "base"].includes(saved.furigana) ? saved.furigana : "above";
        $("track").value = saved.track;
        trackChanged();
        showSlot();
        status("Saved project reopened.");
    } catch (error) {
        status(error instanceof SyntaxError || error instanceof TypeError ? "Choose a valid project ZIP from this app." : error.message, true);
    }
};
