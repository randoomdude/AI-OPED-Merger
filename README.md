# AI OP/ED Merger

Collect song lyrics, align them against an episode, and export merged ASS subtitles. The app reads downloaded MKVs in your browser.

The release lives under `docs/`. Serve that folder over HTTP for local development, for example with `python -m http.server 8000 --directory docs`.

## Using the app

1. Choose a downloaded MKV and select its full subtitle track.
2. Choose Opening or Ending. The app uses the matching MKV chapter start when available. Enter a start if the chapter is missing. The draft ends 1:34 later, or earlier if the chapter or episode ends sooner. You can enter a different end time.
3. Search LRCLIB and import the matching recording, or use the Uta-Net and UtaTen links and paste lyrics with their source URL. Add English, Japanese, or romaji spellings under **Alternate search titles** to search them separately. The app uses the theme catalog for known songs and AniList to look up title variants for other anime.
4. For a timed recording, build a draft to place the source timestamps relative to the episode start. To adjust the timing, choose the first line heard and match it to the playhead. You can also trim the line range or match a later line to correct steady drift. Listen through the draft before exporting.
5. For plain lyrics, build a draft at three seconds per line from the song start. If the song start is blank, a new draft starts at the beginning of the episode. Estimates shorten to fit the available window. Use **Fill missing times** to keep entered timestamps and complete a partial draft. ASS export also fills blank fields in plain lyrics drafts.
6. Download the merged ASS, or export a project ZIP with the original and merged subtitles, the fonts, and a JSON record of the lyrics and timing choices.

To continue editing later, choose the same MKV and open the project ZIP under **Export**.

Under **Jimaku episode subtitles**, check the anime title and episode number detected from the MKV. **Browse on Jimaku** works without a key. For results within the app, enter a key from your [Jimaku account](https://jimaku.cc/account) and use **Search Jimaku**. Jimaku returns episode subtitle files whose song coverage varies by upload. The key stays in this tab and goes only to Jimaku.

## Timing from episode audio

1. With Python, FFmpeg, and [OpenAI Whisper](https://github.com/openai/whisper) installed, download `docs/whisper-helper.py` and run `python whisper-helper.py`. Choose your MKV and enter `OP` or `ED`. The first run with a new model may download its weights. The episode audio is processed locally.
2. Open the same episode and song in the app. If you have the lyrics, use **Paste lyrics or LRC** first. Under **Time from episode audio**, import the `.whisper.json` file saved beside the episode.
3. Review the estimated cues. When matching existing lyrics, the app keeps the wording and leaves unmatched lines unchecked. With no lyrics loaded, the app creates a timed Japanese transcript draft.

The helper uses the matching chapter and prefers a Japanese audio track. On the command line you can set a different window with `--start` and `--end`, or use `--output` to save the timing file elsewhere.

Chapters locate the song within the episode. LRCLIB timestamps describe a specific recording. If the timing jumps at a TV edit, select the first line after the edit as the second anchor, choose **Shift from this line**, and enter when you hear it. You can set the previous line's end to leave a pause. Check the resulting lines against the episode and trim the range where needed.

Preview depends on browser support for the episode's video and audio codecs. If the MKV cannot play, use a same-length preview file with the same time origin, or enter timestamps from your player. This release supports embedded ASS tracks and leaves the episode file untouched.

Searches send titles and artist names to LRCLIB. The app also sends the search text to AniList when it needs to look up title variants. Selected episodes, fonts, and projects are processed in memory and exported to your computer. Save a project ZIP before closing the page.

[Matroska subtitle parser](https://github.com/mathiasvr/matroska-subtitles) · [LRCLIB API](https://lrclib.net/docs.txt)
