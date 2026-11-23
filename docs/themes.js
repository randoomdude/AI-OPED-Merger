export function titleKey(title) {
    return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function titleWithoutYear(title) {
    return title.normalize("NFKC").replace(/\s*\((?:19|20)\d{2}\)$/, "").trim();
}

// Release names sometimes contain both the romaji and the localized title.
export function animeNames(raw) {
    const title = raw.normalize("NFKC").trim();
    const pair = title.match(/^(.+?)\s+\(([^()]+)\)$/);
    return pair && /\p{L}/u.test(pair[2]) ? [title, pair[1], pair[2]] : [title];
}

export function episodeTitle(fileName) {
    const base = fileName.replace(/^(?:\[[^\]]+\]\s*)+/, "").replace(/\.mkv$/i, "");
    const match = base.match(/^(.+?)(?:\s+-\s+(\d+(?:\.\d+)?)(?:v\d+)?(?=\s|\[|\(|$)|([ ._-]+)S\d+E(\d+)\b)/i);
    let anime = match?.[1] || base;
    if (match?.[3]?.includes(".")) anime = anime.replace(/(?<=[\p{L}])\.(?=[\p{L}])/gu, " ");
    if (match?.[3]?.includes("_")) anime = anime.replace(/_/g, " ");
    return { anime: anime.trim(), number: Number(match?.[2] ?? match?.[4]) };
}

const mediaCache = new Map();
async function post(url, body, signal) {
    const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw Error(new URL(url).hostname + " returned HTTP " + response.status + ".");
    return response.json();
}

export async function findAnime(query, signal) {
    const key = titleKey(query);
    if (mediaCache.has(key)) return mediaCache.get(key);
    for (const term of animeNames(query).sort((a, b) => Number(a === query) - Number(b === query))) {
        if (!term) continue;
        const year = term.match(/\(((?:19|20)\d{2})\)$/)?.[1];
        const title = titleWithoutYear(term);
        const { data } = await post("https://graphql.anilist.co", {
            query: "query($title:String){Page(perPage:12){media(type:ANIME,search:$title){idMal seasonYear title{english romaji native} synonyms}}}",
            variables: { title },
        }, signal);
        const matches = (data?.Page?.media || []).map(media => ({
            id: media.idMal, year: media.seasonYear, aliases: [...new Set([media.title.english, media.title.native, media.title.romaji].filter(Boolean))],
            matched: [...Object.values(media.title), ...media.synonyms].some(name => name && titleKey(name) === titleKey(title)),
        })).filter(media => (!year || media.year === Number(year)) && media.matched);
        if (matches.length === 1) {
            mediaCache.set(key, matches[0]);
            return matches[0];
        }
    }
    return null;
}

const themeCache = new Map();
export async function findThemes(media, signal) {
    if (!Number.isInteger(media?.id)) return [];
    if (themeCache.has(media.id)) return themeCache.get(media.id);
    const records = await post("https://anisongdb.com/api/mal_ids_request", { mal_ids: [media.id] }, signal);
    if (!Array.isArray(records)) throw Error("AniSongDB returned an unreadable song list.");
    const songs = [];
    for (const record of records) {
        const type = /^(Opening|Ending)(?:\s+(\d+))?$/i.exec(record.songType);
        if (!type || record.isDub || record.linked_ids?.myanimelist !== media.id || !record.songName) continue;
        const slot = type[1].toLowerCase() === "opening" ? "OP" : "ED";
        const title = record.songName, artist = record.songArtist || "";
        if (songs.some(s => s.slot === slot && s.title === title && s.artist === artist)) continue;
        songs.push({ slot, number: Number(type[2]) || 1, title, artist, sources: {},
            lrclib_search: artist ? { track_name: title, artist_name: artist } : { track_name: title } });
    }
    songs.sort((a, b) => a.number - b.number);
    if (songs.length) themeCache.set(media.id, songs);
    return songs;
}
