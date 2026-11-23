import { dialogueIntervals, dialogueOffset, overlapsDialogue, songGaps } from "./caption-alignment.js";
import { fetchCaptions, parseCaptions, suggestedWindow, lyricWindows, windowCaptions } from "./jimaku.js";
import { shiftRows, songRows } from "./reuse.js";
import { rubyMarkup } from "./furigana.js";
import { findChapter } from "./chapters.js";
import { animeNames, findAnime, findThemes, titleKey, titleWithoutYear } from "./themes.js";
import { timestamp, clock, parseLrc, makeDraft, estimatePlainStart, fillMissingTimes, srtCues,
    originalAss, validatedCues, mergedAss } from "./timing.js";
import { readWhisperTiming, whisperDraft } from "./whisper.js";

const $ = id => document.getElementById(id);
const player = $("player");
const defaultSongDuration = 94_000;
const client = "AI-OPED-Merger/0.1.1 (https://github.com/randoomdude/AI-OPED-Merger)";
const catalog = await fetch("./example-themes.json", { cache: "no-cache" })
    .then(response => response.json()).catch(() => null);
const shows = Array.isArray(catalog) ? catalog : catalog ? [catalog] : [];
let themeRequest;
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

const toolTabs = Array.from(document.querySelectorAll(".tool-tabs [role=tab]"));
function openPanel(id, focus = false) {
    for (const tab of toolTabs) {
        const panel = $(tab.getAttribute("aria-controls"));
        const active = panel.id === id;
        panel.hidden = !active;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        if (active && focus) tab.focus();
    }
}
for (const [index, tab] of toolTabs.entries()) {
    tab.onclick = () => openPanel(tab.getAttribute("aria-controls"));
    tab.onkeydown = event => {
        const destinations = {ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: toolTabs.length - 1};
        if (!Object.hasOwn(destinations, event.key)) return;
        event.preventDefault();
        const next = toolTabs[(destinations[event.key] + toolTabs.length) % toolTabs.length];
        openPanel(next.getAttribute("aria-controls"), true);
    };
}

let needsPreviewCheck = false;
let compatiblePreviewUrl;
function setPreview(file) {
    needsPreviewCheck = desktop && file === episode?.file;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const input = /\.mkv$/i.test(file.name) ? file.slice(0, file.size, "video/x-matroska") : file;
    previewUrl = URL.createObjectURL(input);
    $("playback-note").textContent = "";
    compatiblePreviewUrl = null;
    player.preload = "metadata";
    pendingSeek = null;
    player.src = previewUrl;
}

function catalogShow(title) {
    for (const name of animeNames(title)) {
        const key = titleKey(name);
        const show = shows.find(entry => entry.aliases.some(alias => titleKey(alias) === key));
        if (show) return show;
    }
}

function showForSearch(state, query) {
    const known = catalogShow(query);
    if (known) return known;
    const localShow = episode?.themeShow || catalogShow(state.anime);
    const matchesSong = [state.song?.search_query, state.song?.title].includes(query);
    const matchesUnqualifiedTitle = query === state.anime || localShow?.aliases.some(alias =>
        titleKey(titleWithoutYear(alias)) === titleKey(query));
    return matchesSong || matchesUnqualifiedTitle ? localShow : null;
}

function themeKey(song) {
    return JSON.stringify([song.title, song.artist]);
}

function selectedSong(state, show, name) {
    const choices = show?.songs.filter(s => s.slot === name) || [];
    return choices.find(s => themeKey(s) === state.themeKey) || (choices.length === 1 ? choices[0] : null);
}

function stateFor(name) {
    const chapter = findChapter(episode.chapters, name);
    const { anime } = episode;
    const show = episode.themeShow;
    const song = selectedSong({}, show, name);
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
    localDialogue = selectedTrack ? dialogueIntervals(selectedTrack) : [];
    for (const name of ["OP", "ED"]) {
        const state = slots[name];
        const gaps = selectedTrack?.forced || /^(?:signs|songs|forced)$|\b(?:signs|songs) only\b/i.test(selectedTrack?.name || "")
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
    if (!selectedTrack) $("track-summary").textContent = "This MKV has no readable ASS or SRT track. Choose a separate SRT file for the episode.";
    else if (selectedTrack.type === "utf8") $("track-summary").textContent = selectedTrack.cues.length + " subtitle events · Converted to ASS on export";
    else {
        const styleCount = (selectedTrack.header.match(/^Style:/gm) || []).length;
        $("track-summary").textContent = selectedTrack.cues.length + " subtitle events · " + styleCount
            + " ASS styles · " + episode.fonts.length + " attached fonts";
    }
}

const maxSrtSize = 8 * 1024 * 1024;
function externalSrt(name, content) {
    if (new Blob([content]).size > maxSrtSize) throw Error("The SRT file exceeds 8 MB.");
    const cues = srtCues(content);
    if (!cues.length) throw Error("The SRT file has no readable timed subtitles.");
    return { number: 0, name, type: "utf8", language: "und", cues, srt: content };
}

function showTracks(number) {
    const tracks = $("track");
    tracks.replaceChildren(...episode.tracks.map(track => option(
        (track.name || "Track " + track.number) + " · " + (track.language || "und") +
        " · " + track.cues.length + " cues · " + (track.type === "utf8" ? "SRT" : "ASS"), track.number)));
    if (!episode.tracks.length) tracks.append(option("No embedded ASS or SRT track", ""));
    tracks.value = number ?? "";
    trackChanged();
}

$("external-srt").onchange = async event => {
    const file = event.target.files[0];
    if (!file || !episode) return;
    const opened = episode;
    try {
        if (file.size > maxSrtSize) throw Error("The SRT file exceeds 8 MB.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encoding = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le"
            : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
        const content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        const track = externalSrt(file.name, content);
        if (episode !== opened || event.target.files[0] !== file) return;
        episode.tracks = [...episode.tracks.filter(track => track.number !== 0), track];
        showTracks(track.number);
        status("Loaded " + file.name + " for this episode.");
    } catch (error) {
        if (episode === opened && event.target.files[0] === file) {
            event.target.value = "";
            status(error instanceof TypeError ? "Choose an SRT encoded as UTF-8 or UTF-16 with a byte-order mark." : error.message, true);
        }
    }
};

function showSlot() {
    $("whisper-hint").value = "";
    $("whisper-review").replaceChildren();
    $("reuse-review").replaceChildren();
    $("reuse-file").value = "";
    sourceRequest?.abort();
    const state = slots[slot];
    $("window-start").value = state.windowStart;
    $("window-end").value = state.windowEnd;
    showWindowNote();
    $("query").value = state.query;
    $("alternates").value = state.alternates;
    $("alternates").placeholder = episode.themeShow?.aliases.join("\n") || "One alternate title per line";
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
    const show = showForSearch(state, query);
    const song = selectedSong(state, show, slot);
    const choices = episode.themeShow?.songs.filter(s => s.slot === slot) || [];
    $("theme-choices").hidden = choices.length < 2;
    if (choices.length > 1) {
        $("theme-choice").replaceChildren(option("Choose the theme used in this episode", ""),
            ...choices.map(s => option(slot + (s.number || "") + " · " + s.title + " · " + s.artist, themeKey(s))));
        $("theme-choice").value = state.themeKey || "";
    }
    $("theme-status").textContent = episode.themeNote || (choices.length > 1 && !state.themeKey ? "Several themes are listed for this series."
        : episode.themeShow && !choices.length ? "No " + slot + " song is listed for this series. You can search by song title." : "");
    $("song-title").textContent = song ? song.title + " · " + song.artist : "";
    const searchTitle = song?.title || query;
    for (const [id, key, name, searchUrl] of [
        ["uta-net", "uta_net", "Uta-Net", searchTitle ? "https://www.uta-net.com/search/?" + new URLSearchParams({ target: "title", type: "in", keyword: searchTitle }) : "https://www.uta-net.com/"],
        ["uta-ten", "uta_ten", "UtaTen", searchTitle
            ? "https://utaten.com/search?" + new URLSearchParams({ title: searchTitle, sort: "popular_sort_asc" })
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

$("theme-choice").onchange = () => {
    const state = slots[slot];
    state.themeKey = $("theme-choice").value;
    state.song = selectedSong(state, episode.themeShow, slot);
    state.query = $("query").value = state.song?.search_query || state.song?.title || episode.themeShow.aliases[0];
    showSourceLinks();
};

async function resolveEpisodeThemes(terms) {
    themeRequest?.abort();
    themeRequest = new AbortController();
    const { signal } = themeRequest;
    const opened = episode;
    opened.themeNote = "Looking up opening and ending songs…";
    showSourceLinks();
    try {
        let show, matchedTitle;
        for (const term of uniqueTitles(terms)) {
            matchedTitle = term;
            show = catalogShow(term);
            if (show) break;
            const media = await findAnime(term, signal);
            if (!media) continue;
            show = shows.find(entry => media.aliases.some(alias => entry.aliases.some(a => titleKey(a) === titleKey(alias))));
            if (show) break;
            const songs = await findThemes(media, signal);
            if (songs.length) { show = { aliases: media.aliases, songs }; break; }
        }
        if (episode !== opened || signal.aborted) return;
        if (show) {
            opened.themeShow = show;
            for (const name of ["OP", "ED"]) {
                const state = slots[name];
                const replaceQuery = !state.query || state.query === opened.anime || state.query === state.song?.search_query ||
                    state.query === state.song?.title || state.query === matchedTitle || show.aliases.some(a => titleKey(a) === titleKey(state.query));
                if (state.themeKey && !show.songs.some(s => s.slot === name && themeKey(s) === state.themeKey)) state.themeKey = "";
                state.song = selectedSong(state, show, name);
                if (replaceQuery) state.query = state.song?.search_query || state.song?.title || show.aliases[0];
            }
            $("query").value = slots[slot].query;
            $("alternates").placeholder = show.aliases.join("\n");
            opened.themeNote = "";
        } else opened.themeNote = "No matching themes found. Try an alternate anime title, or enter a song title to search the lyric sites.";
    } catch {
        if (!signal.aborted) opened.themeNote = "The theme database could not be reached. Retry Find OP/ED songs or enter the song title.";
    }
    if (episode === opened && !signal.aborted) showSourceLinks();
}
$("find-themes").onclick = () => resolveEpisodeThemes([slots[slot].query, ...alternateTitles(slots[slot]), episode.anime]);

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
            $("hint-label").hidden = $("run-whisper").hidden = $("export-mkv").hidden = false;
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
    document.querySelector("main").classList.remove("editing");
    $("episode-settings").open = true;
    $("episode-caption").textContent = "";
    openPanel("sources");
    const desktopId = desktop ? crypto.randomUUID() : null;
    if (desktopId) nativeView.postMessageWithAdditionalObjects({ action: "episode", id: desktopId }, [file]);
    worker?.terminate();
    themeRequest?.abort();
    sourceRequest?.abort();
    jimakuRequest?.abort();
    clearCaptionPreview();
    $("furigana-mode").value = "above";
    episode = null;
    $("project").hidden = true;
    $("track-options").hidden = true;
    $("external-srt").value = "";
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
        episode.themeShow = catalogShow(episode.anime);
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
        showTracks(track?.number);
        slot = $("slot").value = "OP";
        $("project").hidden = false;
        $("episode-caption").textContent = file.name;
        $("episode-settings").open = !tracks.length;
        document.querySelector("main").classList.add("editing");
        $("track-options").hidden = false;
        setPreview(file);
        showSlot();
        if (!episode.themeShow) resolveEpisodeThemes([episode.anime]);
        status(!tracks.length ? "Episode ready. Choose a separate SRT file under Episode."
            : english.length === 1 || defaults.length === 1
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
async function prepareCompatiblePreview() {
    if (!needsPreviewCheck || !episode?.desktopId) return;
    needsPreviewCheck = false;
    const opened = episode;
    const original = previewUrl;
    const note = $("playback-note");
    note.textContent = "Preparing the video preview. The first conversion can take a few minutes.";
    try {
        const url = await desktopJob("prepare_preview", opened.desktopId);
        if (episode !== opened || previewUrl !== original) return;
        pendingSeek = pendingSeek ?? player.currentTime * 1000;
        const wasPlaying = !player.paused && !player.ended;
        compatiblePreviewUrl = new URL(url, document.baseURI).href;
        note.textContent = "Loading the video preview…";
        player.preload = "auto";
        player.src = compatiblePreviewUrl;
        if (wasPlaying) player.play().catch(() => {});
    } catch (error) {
        if (episode === opened && previewUrl === original) note.textContent = error.message;
    }
}
function previewDurationDiffers() {
    return episode?.duration && Number.isFinite(player.duration) && Math.abs(player.duration * 1000 - episode.duration) > 1500;
}
player.addEventListener("loadeddata", () => {
    if (!player.videoWidth) prepareCompatiblePreview();
    else if (player.currentSrc === compatiblePreviewUrl && !previewDurationDiffers()) {
        $("playback-note").textContent = "Compatible video preview ready.";
    }
});
player.addEventListener("loadedmetadata", () => {
    if (!player.videoWidth) prepareCompatiblePreview();
    if (Number.isFinite(pendingSeek)) seek(pendingSeek);
    if (previewDurationDiffers()) {
        $("playback-note").textContent = "The preview duration differs from the MKV. Check that their timelines match.";
    }
});
player.addEventListener("error", () => {
    if (needsPreviewCheck) return prepareCompatiblePreview();
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
    if (state.chapter && (timestamp(state.windowStart) !== timestamp(clock(state.chapter.start)) || state.windowEnd)) {
        const restore = text("button", "Use " + slot + " chapter at " + clock(state.chapter.start));
        restore.onclick = () => {
            state.windowStart = clock(state.chapter.start);
            state.windowEnd = state.windowOrigin = "";
            syncWindowFields();
            renderCaptionPreview();
        };
        options.append(restore);
    }
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
        : state.chapter?.inferred && state.windowStart === clock(state.chapter.start) ? "Estimated opening from the second MKV chapter. Check the start against the audio."
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
    const windows = chapterStart && !state.chapter.inferred ? [] : suggestion ? [suggestion] : lyrics;
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
    if (state.source && !window.confirm("Replace the lyrics and timing draft for this song?")) return false;
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
    openPanel("timing");
    return true;
}

$("search").onclick = async () => {
    const query = $("query").value.trim();
    const searching = slots[slot];
    const alternates = alternateTitles(searching);
    if (!query && !alternates.length) return status("Enter a song, artist, or anime title.", true);
    const show = showForSearch(searching, query);
    const song = selectedSong(searching, show, slot);
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
            let titles = show?.aliases;
            if (!titles && query) {
                try { titles = (await findAnime(query, signal))?.aliases.slice(0, 3); }
                catch { signal.throwIfAborted(); }
            }
            const queries = uniqueTitles([song?.search_query || query, ...alternates, ...(titles || []).map(titleWithoutYear)]);
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

function readPreviousMkv(file) {
    return new Promise((resolve, reject) => {
        const reader = new Worker("./extract.js");
        reader.onerror = event => { reader.terminate(); reject(Error(event.message)); };
        reader.onmessage = ({data}) => {
            if ("progress" in data) return;
            reader.terminate();
            if (data.error) reject(Error(data.error));
            else resolve(data);
        };
        reader.postMessage(file);
    });
}

$("reuse-file").onchange = async event => {
    const file = event.target.files[0];
    const state = slots[slot];
    const name = slot;
    const review = $("reuse-review");
    const current = () => slots?.[slot] === state && $("reuse-file").files[0] === file;
    review.textContent = "Finding " + name + " subtitle events…";
    try {
        let tracks;
        let anchor;
        if (/\.mkv$/i.test(file.name)) {
            const old = await readPreviousMkv(file);
            tracks = old.tracks.filter(track => track.type === "ass")
                .map(track => ({name: track.name || "Track " + track.number, script: originalAss(track)}));
            anchor = findChapter(old.chapters, name)?.start;
        } else tracks = [{name: file.name, script: await file.text()}];
        if (!current()) return;
        const choices = tracks.map(track => ({name: track.name, rows: songRows(track.script, name)})).filter(item => item.rows.length);
        if (!choices.length) throw Error("No " + name + " events labeled by actor or style in this file. Choose a completed song export or switch Opening / Ending.");
        const select = document.createElement("select");
        select.setAttribute("aria-label", "Previous song track");
        choices.forEach((item, i) => select.append(option(item.name, i)));
        const preview = document.createElement("div");
        review.replaceChildren(select, preview);
        function show() {
            const rows = choices[select.value].rows;
            const oldStart = document.createElement("input");
            const newStart = document.createElement("input");
            oldStart.value = clock(anchor ?? timestamp(rows[0].start));
            newStart.value = state.windowStart || oldStart.value;
            const oldLabel = text("label", "Previous episode song start" + (anchor == null ? " (defaults to first lyric)" : " (chapter)"));
            const newLabel = text("label", "Current episode song start");
            oldLabel.append(oldStart);
            newLabel.append(newStart);
            const sample = document.createElement("details");
            sample.append(text("summary", "Review " + rows.length + " timed lyric groups"));
            for (const row of rows) sample.append(text("p", row.start + " · " + row.text));
            const apply = text("button", "Import timed " + name);
            function update() {
                const delta = timestamp(newStart.value) - timestamp(oldStart.value);
                apply.disabled = !Number.isFinite(delta);
                apply.textContent = "Import " + name + (apply.disabled ? "" : " with " + (delta >= 0 ? "+" : "") + (delta/1000).toFixed(3) + " s shift");
            }
            oldStart.oninput = newStart.oninput = update;
            update();
            apply.onclick = () => {
                if (!current()) return;
                try {
                    const shifted = shiftRows(rows, timestamp(newStart.value) - timestamp(oldStart.value), episode.duration);
                    if (!setSource({provider: "Previous episode", title: file.name, plain: "", synced: "", url: ""})) return;
                    state.rows = shifted;
                    state.windowStart = clock(timestamp(newStart.value));
                    state.windowEnd = "";
                    state.windowOrigin = "manual";
                    syncWindowFields();
                    showTiming();
                    status("Imported " + name + " with its original ASS formatting.");
                } catch (error) { status(error.message, true); }
            };
            preview.replaceChildren(oldLabel, newLabel, sample, apply);
        }
        select.onchange = show;
        show();
    } catch (error) { if (current()) review.textContent = error.message; }
};

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
        await applyWhisper(() => desktopJob("time_song", episode.desktopId, slot, start, end, $("whisper-hint").value.trim()));
    } finally {
        progress.hidden = true;
        button.disabled = $("jimaku-whisper").disabled = $("export-mkv").disabled = false;
    }
};

$("jimaku-whisper").onclick = () => {
    openPanel("audio-options", true);
    if (desktop) $("run-whisper").click();
};

async function applyWhisper(read) {
    const opened = episode;
    const selected = slot;
    const state = slots[selected];
    const source = state.source;
    const songName = selected === "OP" ? "opening" : "ending";
    const start = state.windowStart, end = state.windowEnd;
    const originalRows = state.rows.map(({text, start, end, include}) => ({text, start, end, include}));
    function changedSinceReview() {
        if (episode !== opened || slot !== selected || slots[selected] !== state) return "The episode or song selection changed.";
        if (start !== state.windowStart || end !== state.windowEnd) return "The " + songName + " time window changed.";
        if (source !== state.source) return "The lyrics source for the " + songName + " changed.";
        if (originalRows.length !== state.rows.length) return "The " + songName + " draft now has " + state.rows.length + " lines.";
        for (const [index, row] of originalRows.entries()) {
            for (const field of Object.keys(row)) {
                if (row[field] !== state.rows[index][field]) {
                    const label = field === "include" ? "export checkbox" : field;
                    return "The " + label + " changed on line " + (index + 1) + " of the " + songName + " draft.";
                }
            }
        }
        return "";
    }
    try {
        const input = await read();
        function reviewIsStale() {
            const reason = changedSinceReview();
            if (!reason) return false;
            if (episode === opened && selected === slot && slots[selected] === state) {
                const review = $("whisper-review");
                review.replaceChildren(text("p", reason));
                if (start === state.windowStart && end === state.windowEnd) {
                    const compare = text("button", "Compare this audio with the current draft");
                    compare.onclick = () => {
                        if (episode === opened && slot === selected && start === state.windowStart && end === state.windowEnd)
                            applyWhisper(() => input);
                        else status("Run Whisper for the current song window.", true);
                    };
                    review.append(compare);
                }
            }
            status(reason + " Review the current song before applying timing.", true);
            return true;
        }
        if (reviewIsStale()) return;
        const data = readWhisperTiming(input, opened.file, selected, opened.duration);
        if (!state.rows.length && state.lines.length) {
            throw Error("Build the timing draft from your timed lyrics first, then compare it with Whisper.");
        }
        const reference = state.rows.length ? state.rows : plainRows(source?.plain ?? "");
        const { rows, matched } = whisperDraft(data, reference);
        const review = $("whisper-review");
        review.replaceChildren(text("p", reference.length
            ? matched + " of " + reference.filter(row => row.include).length + " selected lines matched. Review the proposed times."
            : "Whisper found " + matched + " transcript lines. Choose whether to use them as lyrics."));
        const changes = reference.flatMap((row, i) => rows[i] !== row ? [{ index: i, before: row, after: rows[i] }] : []);
        const selectedLines = new Set(changes.map(change => change.index));
        const actions = document.createElement("div");
        actions.className = "row";
        const cutButton = reference.length ? offer("Apply reviewed timing and exclusions", () => applyReviewed(true)) : null;
        const timingButton = changes.length ? offer("Apply timing only", () => applyReviewed(false)) : null;
        if (cutButton) {
            cutButton.className = "primary";
            review.append(text("p", "Only checked lines will be included in the TV cut. Check any missed lyrics before applying, or re-enable them later in Line timing."));
            updateButtons();
        }
        function updateButtons() {
            const count = selectedLines.size;
            cutButton.textContent = "Apply reviewed timing and exclusions (" + count + (count === 1 ? " line)" : " lines)");
            cutButton.disabled = count === 0;
            if (timingButton) timingButton.disabled = !changes.some(change => selectedLines.has(change.index));
        }
        function lineCheckbox(index) {
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = selectedLines.has(index);
            input.onchange = () => {
                if (input.checked) selectedLines.add(index);
                else selectedLines.delete(index);
                updateButtons();
            };
            return input;
        }
        for (const {index, before, after} of changes) {
            const label = text("label", "Line " + (index + 1) + " · " + before.text + " · " + (before.start || "untimed") + " – " + (before.end || "untimed")
                + " → " + after.start + " – " + after.end, "inline");
            label.prepend(lineCheckbox(index));
            const jump = text("button", "Hear proposed time");
            jump.onclick = () => seek(timestamp(after.start));
            const item = document.createElement("div");
            item.append(label, jump);
            review.append(item);
        }
        const uncertain = reference.map((row, index) => ({row, index}))
            .filter(({row, index}) => row.include && rows[index] === row);
        if (uncertain.length) {
            const panel = document.createElement("details");
            panel.append(text("summary", "Review " + uncertain.length + " lines Whisper could not place"));
            panel.append(text("p", "Check any additional lyric you hear in the TV cut. It will use its draft time."));
            for (const {row, index} of uncertain) {
                const item = document.createElement("div");
                const label = text("label", "Include line " + (index + 1) + " · " + row.text, "inline");
                label.prepend(lineCheckbox(index));
                item.append(label);
                if (Number.isFinite(timestamp(row.start))) {
                    const jump = text("button", "Go to draft time " + row.start);
                    jump.onclick = () => seek(timestamp(row.start));
                    item.append(jump);
                }
                panel.append(item);
            }
            review.append(panel);
        }
        function offer(label, action) {
            const button = text("button", label);
            button.onclick = () => {
                if (reviewIsStale()) return;
                try { action(); } catch (error) { status(error.message, true); }
            };
            actions.append(button);
            return button;
        }
        function applyReviewed(tvCut) {
            const next = reference.map((original, index) => {
                if (selectedLines.has(index)) return rows[index];
                if (tvCut && original.include) return { ...original, include: false };
                return original;
            });
            apply(next);
            if (tvCut) status("Applied the TV cut with " + selectedLines.size + " of " + reference.length
                + (selected === "OP" ? " opening" : " ending") + " lines selected for export.");
        }
        function apply(next, replace = false) {
            if (replace && !setSource({provider: "Local Whisper", plain: next.map(row => row.text).join("\n"), synced: "", url: ""})) return;
            state.rows = next;
            state.source = {...state.source, whisper: true};
            state.windowStart ||= clock(data.start_ms);
            state.windowEnd ||= clock(data.end_ms);
            syncWindowFields();
            review.replaceChildren();
            showTiming();
            openPanel("timing");
            status("Applied the selected Whisper changes.");
        }
        const offsets = changes.filter(({before}) => Number.isFinite(timestamp(before.start)))
            .map(({before, after}) => timestamp(after.start) - timestamp(before.start)).sort((a,b) => a-b);
        if (offsets.length) {
            const mid = Math.floor(offsets.length / 2);
            const delta = Math.round((offsets[mid] + offsets[Math.floor((offsets.length-1)/2)]) / 20) * 10;
            offer("Shift all lines by " + (delta / 1000) + " s", () => apply(shiftRows(reference, delta, opened.duration)));
        }
        offer(reference.length ? "Replace lyrics with Whisper transcription…" : "Use Whisper transcription", () =>
            apply(whisperDraft(data, []).rows, true));
        review.append(actions);
        status(reference.length ? "Whisper comparison ready. Review the proposed times for the " + songName + "."
            : "Whisper found transcript lines. Choose Use Whisper transcription to create the " + songName + " draft.");
    } catch (error) {
        status(error instanceof SyntaxError ? "Choose a valid timing JSON file from the Whisper helper." : error.message, true);
    }
}

function showTiming() {
    const state = slots[slot];
    const name = slot === "OP" ? "Opening" : "Ending";
    $("draft-title").textContent = name + " draft · Line timing";
    $("draft-empty").hidden = state.rows.length > 0;
    $("draft-empty").textContent = state.source ? "Lyrics selected. Build a timing draft to edit individual lines."
        : "No lyric lines yet. Import lyrics from Source lyrics or choose Use Whisper transcription after an audio review.";
    $("source-status").textContent = state.source ? (state.source.title || state.source.provider)
        + " · " + (state.source.whisper ? "Timing from episode audio"
            : state.source.provider === "Jimaku" ? "Episode subtitle timing" : state.lines.length ? state.lines.length + " timed source lines" : "Manual timing") : "";
    const timed = Boolean(state.lines.length);
    $("anchors").hidden = !timed;
    $("plain-hint").hidden = !state.source || timed || state.source.whisper === true || state.source.provider === "Jimaku";
    $("draft").hidden = !state.source || ["Local Whisper", "Jimaku", "Previous episode"].includes(state.source.provider);
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
    $("tab-timing").textContent = "Draft (" + rows.length + ")";
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
        lyric.readOnly = Boolean(row.events);
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
    function report(message, error = false) {
        $("export-status").textContent = message;
        status(message, error);
    }
    $("export-status").textContent = "";
    try {
        if (!selectedTrack) throw Error("Choose a subtitle track or an SRT file under Episode before exporting.");
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
                report("Choose a new filename. After you select Save, the app writes the MKV.");
                try {
                    saved = await desktopJob("save_mkv", episode.desktopId, ass, selectedTrack.language);
                } finally {
                    $("jimaku-whisper").disabled = $("export-mkv").disabled = $("run-whisper").disabled = false;
                }
                if (!saved) return report("Save canceled.");
                report("Saved " + saved.path + (saved.warnings.length ? " · " + saved.warnings.join(" ") : ""));
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
                srtName: selectedTrack.number === 0 ? selectedTrack.name : undefined,
            }, null, 2)),
        };
        if (selectedTrack.number === 0) pack["original.srt"] = fflate.strToU8(selectedTrack.srt);
        if (cues?.length) pack["merged.ass"] = fflate.strToU8(mergedAss(original, cues, $("furigana-mode").value));
        episode.fonts.forEach((font, index) => {
            const name = font.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
            pack["fonts/" + String(index + 1) + "-" + name] = font.data;
        });
        download(name + ".oped.zip", fflate.zipSync(pack, { level: 0 }), "application/zip");
        status(cues?.length ? "Project ZIP exported with merged ASS." : "Project ZIP exported with original subtitles and draft data.");
    } catch (error) {
        report(error.message, true);
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
        const files = fflate.unzipSync(bytes, { filter: entry =>
            ["project.json", "original.srt"].includes(entry.name) && entry.originalSize <= maxSrtSize });
        const saved = JSON.parse(fflate.strFromU8(files["project.json"]));
        if (opened !== episode) return;
        const srt = saved.track === 0 && typeof saved.srtName === "string" && files["original.srt"]
            ? externalSrt(saved.srtName, fflate.strFromU8(files["original.srt"])) : null;
        if (saved.version !== 1 || saved.mkv !== episode.file.name || saved.mkv_size !== episode.file.size
            || saved.duration_ms !== episode.duration ||
            (saved.track === 0 ? !srt : !episode.tracks.some(track => track.number === saved.track))) {
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
            if (typeof song.themeKey === "string") {
                base.themeKey = song.themeKey;
                base.song = selectedSong(base, episode.themeShow, name);
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
        if (srt) {
            episode.tracks = [...episode.tracks.filter(track => track.number !== 0), srt];
            $("external-srt").value = "";
        }
        showTracks(saved.track);
        showSlot();
        openPanel("timing");
        status("Saved project reopened.");
    } catch (error) {
        status(error instanceof SyntaxError || error instanceof TypeError ? "Choose a valid project ZIP from this app." : error.message, true);
    }
};

// The picker can receive a file while the browser is still loading this module and its catalog.
const initialFile = $("episode").files[0];
if (initialFile) loadEpisode(initialFile);
