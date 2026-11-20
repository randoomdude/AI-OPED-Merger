import { timestamp, clock, parseLrc, makeDraft, originalAss, validatedCues, mergedAss } from "./timing.js";

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
let worker;
let previewUrl;
let slot = "OP";
let slots;
let sourceRequest;
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
    const filename = episode.file.name.replace(/^(?:\[[^\]]+\]\s*)+/, "");
    const anime = filename.match(/^(.+?)\s+-\s+\d+/)?.[1] || filename.replace(/\.mkv$/i, "");
    const show = catalogShow(anime);
    const song = show?.songs.find(item => item.slot === name) || null;
    return {
        chapter, anime, song, windowStart: clock(chapter?.start), windowEnd: "",
        query: song?.search_query || song?.title || anime, source: null, lines: [], rows: [],
        first: 0, last: 0, second: null, firstEpisode: "", secondEpisode: "",
        secondMode: "drift", beforeCutEnd: "",
    };
}

function timingDefaults(state) {
    const start = timestamp(state.windowStart);
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
    const styleCount = (selectedTrack.header.match(/^Style:/gm) || []).length;
    $("track-summary").textContent = selectedTrack.cues.length + " subtitle events · " + styleCount
        + " ASS styles · " + episode.fonts.length + " attached fonts";
}

function showSlot() {
    sourceRequest?.abort();
    const state = slots[slot];
    $("window-start").value = state.windowStart;
    $("window-end").value = state.windowEnd;
    $("chapter-note").textContent = state.chapter
        ? "Song start from the MKV chapter named " + state.chapter.title + "."
        : "Enter the song’s start in the episode.";
    $("query").value = state.query;
    $("source-url").value = state.source?.url || state.song?.sources.uta_net || "";
    $("paste").value = "";
    showSourceLinks();
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

function loadEpisode(file) {
    worker?.terminate();
    sourceRequest?.abort();
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
        episode = { ...data, file };
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
    if (episode?.duration && Number.isFinite(player.duration) && Math.abs(player.duration * 1000 - episode.duration) > 1500) {
        $("playback-note").textContent = "The preview duration differs from the MKV. Check that their timelines match.";
    }
});
player.addEventListener("error", () => {
    $("playback-note").textContent = "This file could not play in your browser. Use a matching preview file or enter times from your video player.";
});

function seek(ms) {
    if (player.readyState && Number.isFinite(ms)) {
        player.currentTime = Math.max(0, ms / 1000);
        $("playhead").textContent = clock(player.currentTime * 1000);
    }
}
$("jump").onclick = () => seek(timestamp($("window-start").value));
$("back").onclick = () => seek(player.currentTime * 1000 - 2000);
$("forward").onclick = () => seek(player.currentTime * 1000 + 2000);
for (const [id, key] of [["query", "query"], ["window-start", "windowStart"], ["window-end", "windowEnd"],
    ["first-episode", "firstEpisode"], ["second-episode", "secondEpisode"], ["before-cut-end", "beforeCutEnd"]]) {
    $(id).addEventListener("input", event => { slots[slot][key] = event.target.value; });
}
$("query").addEventListener("input", showSourceLinks);
$("window-start").addEventListener("input", showTimingDefaults);
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
    if (!query) return status("Enter a song, artist, or anime title.", true);
    const searching = slots[slot];
    const show = showForSearch(searching, query);
    const song = show?.songs.find(item => item.slot === slot);
    const signal = beginSourceRequest();
    $("search-status").textContent = "Searching LRCLIB…";
    $("results").replaceChildren();
    try {
        let rows;
        if (song?.lrclib_search) {
            const variants = [song.lrclib_search, ...(song.lrclib_alternates ?? [])];
            rows = await searchLyrics(variants, signal);
            if (!rows.length && song.lrclib_alternates?.length) {
                const songTitles = [...new Set(variants.map(entry => entry.track_name))];
                const artists = variants.map(entry => titleKey(entry.artist_name));
                const candidates = [...animeQueries(show.aliases), ...songTitles.map(track_name => ({ track_name }))];
                rows = (await searchLyrics(candidates, signal)).filter(record =>
                    songTitles.some(title => titleKey(record.trackName).startsWith(titleKey(title))) && artists.includes(titleKey(record.artistName)));
            }
        } else {
            const titles = show?.aliases ?? await animeTitles(query, signal);
            rows = await searchLyrics([{ q: song?.search_query || query }, ...animeQueries(titles)], signal);
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

$("use-paste").onclick = () => {
    try {
        const url = new URL($("source-url").value);
        const plain = $("paste").value.trim();
        if (!["https:", "http:"].includes(url.protocol) || !plain) throw Error();
        const lines = parseLrc(plain);
        setSource({ provider: "Pasted text", url: url.href, plain: lines.length ? "" : plain, synced: lines.length ? plain : "" });
    } catch {
        status("Enter some lyrics and a complete source URL.", true);
    }
};

function showTiming() {
    const state = slots[slot];
    $("timing").hidden = !state.source;
    $("source-status").textContent = state.source ? (state.source.title || state.source.provider)
        + " · " + (state.lines.length ? state.lines.length + " timed source lines" : "Manual timing") : "";
    const timed = Boolean(state.lines.length);
    $("anchors").hidden = !timed;
    $("plain-hint").hidden = timed;
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
    const rows = slots[slot].rows;
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
        }) : state.source.plain.split(/\r?\n/).filter(line => line.trim()).map(line =>
            ({ text: line.trim(), start: "", end: "", include: true }));
        showRows();
        status(state.lines.length ? "Draft created. Listen through and adjust its cues." : "Draft created. Set each line’s start and end.");
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

function exportProject(zip) {
    try {
        const original = originalAss(selectedTrack);
        const rows = Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, value.rows]));
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
            download(name + ".oped.ass", mergedAss(original, cues), "text/plain;charset=utf-8");
            status("Merged ASS exported.");
            return;
        }
        const pack = {
            "original.ass": fflate.strToU8(original),
            "project.json": fflate.strToU8(JSON.stringify({
                version: 1, mkv: episode.file.name, mkv_size: episode.file.size,
                track: selectedTrack.number, duration_ms: episode.duration,
                chapters: episode.chapters, songs: slots,
            }, null, 2)),
        };
        if (cues?.length) pack["merged.ass"] = fflate.strToU8(mergedAss(original, cues));
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
            for (const key of ["query", "windowStart", "windowEnd", "firstEpisode", "secondEpisode", "beforeCutEnd"]) {
                if (typeof song[key] === "string") base[key] = song[key];
            }
            if (song.secondMode === "shift") base.secondMode = "shift";
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
        $("track").value = saved.track;
        trackChanged();
        showSlot();
        status("Saved project reopened.");
    } catch (error) {
        status(error instanceof SyntaxError || error instanceof TypeError ? "Choose a valid project ZIP from this app." : error.message, true);
    }
};
