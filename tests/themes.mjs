import assert from "node:assert/strict";
import test from "node:test";
import { episodeTitle, findAnime } from "../docs/themes.js";

test("scene release names retain the anime name and remove episode and encoding metadata", () => {
    assert.deepEqual(episodeTitle("Even.the.Student.Council.Has.Its.Holes.S01E08.Satomis.World.1080p.ADN.WEB-DL.mkv"), {
        anime: "Even the Student Council Has Its Holes", number: 8,
    });
    assert.deepEqual(episodeTitle("[Erai-raws] Mattaku Saikin no Tantei to Kitara - 09 [1080p].mkv"), {
        anime: "Mattaku Saikin no Tantei to Kitara", number: 9,
    });
});

test("AniList can match a typed synonym but only returns the full English, Japanese and romaji titles", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: { Page: { media: [{
        idMal: 61578, seasonYear: 2026,
        title: { english: "Even the Student Council Has Its Holes!", native: "生徒会にも穴はある！", romaji: "Seitokai ni mo Ana wa Aru!" },
        synonyms: ["生穴る", "NamaAnaru", "สภานักเรียนฉบับรั่ว!"],
    }] } } });
    try {
        const match = await findAnime("NamaAnaru", new AbortController().signal);
        assert.deepEqual(match.aliases, ["Even the Student Council Has Its Holes!", "生徒会にも穴はある！", "Seitokai ni mo Ana wa Aru!"]);
    } finally {
        globalThis.fetch = original;
    }
});
